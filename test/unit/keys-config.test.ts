import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildConfig, loadSecretFiles, parseTrustProxy } from '../../src/config/config';
import { displayPrefix, generateApiKey, hashApiKey, looksLikeApiKey, safeEqual } from '../../src/keys/key-format';

describe('API key format', () => {
  it('generates mode-prefixed 256-bit keys', () => {
    const s = generateApiKey('sandbox');
    const l = generateApiKey('live');
    expect(s.startsWith('mk_sbx_')).toBe(true);
    expect(l.startsWith('mk_live_')).toBe(true);
    expect(generateApiKey('approval').startsWith('mk_live_')).toBe(true);
    expect(looksLikeApiKey(s)).toBe(true);
    expect(generateApiKey('sandbox')).not.toBe(s);
  });
  it('hashes with sha256 and displays only a short prefix', () => {
    const s = generateApiKey('live');
    expect(hashApiKey(s)).toMatch(/^[0-9a-f]{64}$/);
    expect(displayPrefix(s)).toBe(s.slice(0, 12) + '…');
  });
  it('safeEqual compares correctly regardless of length', () => {
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(safeEqual('abc', 'abd')).toBe(false);
    expect(safeEqual('abc', 'abcd')).toBe(false);
  });
});

describe('config', () => {
  it('loads *_FILE secrets without overriding explicit values', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mg-'));
    writeFileSync(join(dir, 'pw'), 's3cret\n');
    const env: NodeJS.ProcessEnv = { SMTP_PASSWORD_FILE: join(dir, 'pw'), RESEND_API_KEY: 'explicit', RESEND_API_KEY_FILE: join(dir, 'pw') };
    loadSecretFiles(env);
    expect(env.SMTP_PASSWORD).toBe('s3cret');
    expect(env.RESEND_API_KEY).toBe('explicit');
  });
  it('validates and applies defaults', () => {
    const c = buildConfig({ DATABASE_URL: 'postgres://x', SMTP_HOST: 'smtp.example.com' });
    expect(c.smtpEnabled).toBe(true);
    expect(c.DEDUP_WINDOW_SECONDS).toBe(600);
    expect(c.LIVE_PROVIDER).toBe('smtp');
    expect(() => buildConfig({})).toThrow(/DATABASE_URL/);
    expect(() => buildConfig({ DATABASE_URL: 'x', ADMIN_TOKEN: 'short' })).toThrow(/ADMIN_TOKEN/);
  });
  it('parses trust proxy', () => {
    expect(parseTrustProxy('false')).toBe(false);
    expect(parseTrustProxy('1')).toBe(1);
    expect(parseTrustProxy('10.0.0.5, 10.0.0.6')).toEqual(['10.0.0.5', '10.0.0.6']);
  });
});
