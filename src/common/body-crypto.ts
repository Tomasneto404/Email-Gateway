// Authored by Tomás Neto (TN 2026)
import { Inject, Injectable, Logger } from '@nestjs/common';
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';
import { APP_CONFIG, AppConfig } from '../config/config';

const TEXT_PREFIX = 'enc:v1:';
const BYTES_MAGIC = Buffer.from('MGE1');

/** A purpose-specific 32-byte key derived from APP_ENCRYPTION_KEY (HKDF-SHA256). */
export function deriveKey(appKeyBase64: string, purpose: string): Buffer {
  return Buffer.from(hkdfSync('sha256', Buffer.from(appKeyBase64, 'base64'), Buffer.alloc(0), `mail-gateway:${purpose}`, 32));
}

/**
 * Message bodies and attachments at rest: AES-256-GCM with a key derived from APP_ENCRYPTION_KEY.
 *  - text: "enc:v1:<iv>.<tag>.<ciphertext>" (base64url)
 *  - bytes: "MGE1" | iv(12) | tag(16) | ciphertext
 * Without APP_ENCRYPTION_KEY values are stored as they are. Reading always accepts plain values,
 * so rows written before encryption was enabled keep working (`messages:encrypt-bodies` converts them).
 */
@Injectable()
export class BodyCrypto {
  private readonly key: Buffer | null;

  constructor(@Inject(APP_CONFIG) cfg: AppConfig) {
    this.key = cfg.APP_ENCRYPTION_KEY ? deriveKey(cfg.APP_ENCRYPTION_KEY, 'message-bodies') : null;
    if (!this.key) new Logger('BodyCrypto').warn('APP_ENCRYPTION_KEY is not set: message bodies are stored unencrypted.');
  }

  get enabled() {
    return !!this.key;
  }

  static isSealedText(v: string | null | undefined): boolean {
    return typeof v === 'string' && v.startsWith(TEXT_PREFIX);
  }

  static isSealedBytes(v: Uint8Array | null | undefined): boolean {
    return !!v && v.length >= 32 && Buffer.from(v.subarray(0, 4)).equals(BYTES_MAGIC);
  }

  sealText(v: string | null | undefined): string | null {
    if (v === null || v === undefined) return null;
    if (!this.key || BodyCrypto.isSealedText(v)) return v;
    const iv = randomBytes(12);
    const c = createCipheriv('aes-256-gcm', this.key, iv);
    const ct = Buffer.concat([c.update(v, 'utf8'), c.final()]);
    return `${TEXT_PREFIX}${iv.toString('base64url')}.${c.getAuthTag().toString('base64url')}.${ct.toString('base64url')}`;
  }

  openText(v: string | null | undefined): string | null {
    if (v === null || v === undefined) return null;
    if (!BodyCrypto.isSealedText(v)) return v;
    const [iv, tag, ct] = v.slice(TEXT_PREFIX.length).split('.');
    const d = createDecipheriv('aes-256-gcm', this.requireKey(), Buffer.from(iv, 'base64url'));
    d.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([d.update(Buffer.from(ct, 'base64url')), d.final()]).toString('utf8');
  }

  sealBytes(v: Buffer): Buffer {
    if (!this.key || BodyCrypto.isSealedBytes(v)) return v;
    const iv = randomBytes(12);
    const c = createCipheriv('aes-256-gcm', this.key, iv);
    const ct = Buffer.concat([c.update(v), c.final()]);
    return Buffer.concat([BYTES_MAGIC, iv, c.getAuthTag(), ct]);
  }

  openBytes(v: Uint8Array): Buffer {
    const b = Buffer.from(v);
    if (!BodyCrypto.isSealedBytes(b)) return b;
    const d = createDecipheriv('aes-256-gcm', this.requireKey(), b.subarray(4, 16));
    d.setAuthTag(b.subarray(16, 32));
    return Buffer.concat([d.update(b.subarray(32)), d.final()]);
  }

  private requireKey(): Buffer {
    if (!this.key) throw new Error('This message body is encrypted but APP_ENCRYPTION_KEY is not configured.');
    return this.key;
  }
}
