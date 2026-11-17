// Authored by Tomás Neto (TN 2026)
import { Inject, Injectable } from '@nestjs/common';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { APP_CONFIG, AppConfig } from '../config/config';

/** AES-256-GCM for small secrets at rest (TOTP seeds). Format: v1.<iv>.<tag>.<ciphertext> (base64url). */
@Injectable()
export class SecretBox {
  private readonly key: Buffer | null;
  constructor(@Inject(APP_CONFIG) cfg: AppConfig) {
    this.key = cfg.APP_ENCRYPTION_KEY ? Buffer.from(cfg.APP_ENCRYPTION_KEY, 'base64') : null;
  }

  get available() {
    return !!this.key;
  }

  private requireKey(): Buffer {
    if (!this.key) throw new Error('APP_ENCRYPTION_KEY is not configured; it is required for admin users (TOTP).');
    return this.key;
  }

  seal(plain: string): string {
    const iv = randomBytes(12);
    const c = createCipheriv('aes-256-gcm', this.requireKey(), iv);
    const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
    return ['v1', iv.toString('base64url'), c.getAuthTag().toString('base64url'), ct.toString('base64url')].join('.');
  }

  open(sealed: string): string {
    const [v, iv, tag, ct] = sealed.split('.');
    if (v !== 'v1') throw new Error('unknown secret format');
    const d = createDecipheriv('aes-256-gcm', this.requireKey(), Buffer.from(iv, 'base64url'));
    d.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([d.update(Buffer.from(ct, 'base64url')), d.final()]).toString('utf8');
  }
}

export const sha256hex = (s: string) => createHash('sha256').update(s).digest('hex');
export const randomToken = (bytes = 32) => randomBytes(bytes).toString('base64url');
