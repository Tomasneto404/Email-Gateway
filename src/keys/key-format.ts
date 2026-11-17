// Authored by Tomás Neto (TN 2026)
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

const ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

function base62(buf: Buffer): string {
  let n = BigInt('0x' + buf.toString('hex'));
  let out = '';
  while (n > 0n) {
    out = ALPHABET[Number(n % 62n)] + out;
    n /= 62n;
  }
  return out.padStart(43, '0');
}

export type KeyModeLike = 'sandbox' | 'live' | 'approval';

export function prefixForMode(mode: KeyModeLike): 'mk_sbx_' | 'mk_live_' {
  return mode === 'sandbox' ? 'mk_sbx_' : 'mk_live_';
}

/** 256 bits of entropy, base62, prefixed by mode at issuance. */
export function generateApiKey(mode: KeyModeLike): string {
  return prefixForMode(mode) + base62(randomBytes(32));
}

export function hashApiKey(secret: string): string {
  return createHash('sha256').update(secret, 'utf8').digest('hex');
}

/** Non-secret display prefix, e.g. "mk_live_3fA9…". */
export function displayPrefix(secret: string): string {
  const p = secret.startsWith('mk_live_') ? 'mk_live_' : 'mk_sbx_';
  return p + secret.slice(p.length, p.length + 4) + '…';
}

export function looksLikeApiKey(s: string): boolean {
  return /^mk_(sbx|live)_[0-9A-Za-z]{43}$/.test(s);
}

/** Constant-time comparison of two hex digests (or any equal-purpose strings). */
export function safeEqual(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a).digest();
  const hb = createHash('sha256').update(b).digest();
  return timingSafeEqual(ha, hb) && a.length === b.length;
}
