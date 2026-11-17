// Authored by Tomás Neto (TN 2026)
import { describe, expect, it } from 'vitest';
import { neutralizeHtml, previewCsp } from '../../src/admin/admin.controllers';
import { groupsFromClaim } from '../../src/auth/authentik.service';
import { covers, effectivePermissions, hasPermission, isValidPermission } from '../../src/auth/permissions';
import { SecretBox } from '../../src/auth/crypto';
import { base32Decode, base32Encode, hotp, otpauthUri, totp, verifyTotp } from '../../src/auth/totp';
import { buildConfig } from '../../src/config/config';
import { UI_CSP } from '../../src/ui-static';

describe('TOTP (RFC 6238 / 4226)', () => {
  // RFC 4226 appendix D, secret "12345678901234567890"
  const key = Buffer.from('12345678901234567890');
  it('HOTP test vectors', () => {
    expect([0, 1, 2, 3, 9].map((c) => hotp(key, c))).toEqual(['755224', '287082', '359152', '969429', '520489']);
  });
  it('TOTP RFC 6238 SHA1 vectors (6 digits)', () => {
    const secret = base32Encode(key);
    expect(totp(secret, 59_000)).toBe('287082');
    expect(totp(secret, 1111111109_000)).toBe('081804');
    expect(totp(secret, 2000000000_000)).toBe('279037');
  });
  it('base32 round trip', () => {
    expect(base32Decode(base32Encode(key)).equals(key)).toBe(true);
  });
  it('verifies within ±1 step and returns the step', () => {
    const secret = base32Encode(key);
    const now = 1111111109_000;
    expect(verifyTotp(secret, totp(secret, now), now)).toBe(Math.floor(now / 30_000));
    expect(verifyTotp(secret, totp(secret, now - 30_000), now)).not.toBeNull();
    expect(verifyTotp(secret, totp(secret, now - 90_000), now)).toBeNull();
    expect(verifyTotp(secret, 'abcdef', now)).toBeNull();
  });
  it('otpauth URI', () => {
    expect(otpauthUri('ABC', 'a@b.c')).toBe('otpauth://totp/mail-gateway%3Aa%40b.c?secret=ABC&issuer=mail-gateway&algorithm=SHA1&digits=6&period=30');
  });
});

describe('SecretBox', () => {
  const cfg = buildConfig({ DATABASE_URL: 'x', APP_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString('base64') });
  it('round-trips and is non-deterministic', () => {
    const box = new SecretBox(cfg);
    const a = box.seal('JBSWY3DPEHPK3PXP');
    expect(a).not.toBe(box.seal('JBSWY3DPEHPK3PXP'));
    expect(box.open(a)).toBe('JBSWY3DPEHPK3PXP');
  });
  it('detects tampering', () => {
    const box = new SecretBox(cfg);
    const [v, iv, tag, ct] = box.seal('secret').split('.');
    const bad = [v, iv, tag, Buffer.from('x' + Buffer.from(ct, 'base64url').toString('latin1')).toString('base64url')].join('.');
    expect(() => box.open(bad)).toThrow();
  });
  it('rejects wrong-length keys in config', () => {
    expect(() => buildConfig({ DATABASE_URL: 'x', APP_ENCRYPTION_KEY: 'c2hvcnQ=' })).toThrow(/APP_ENCRYPTION_KEY/);
  });
});

describe('RBAC permission logic', () => {
  it('groups claim normalisation', () => {
    expect(groupsFromClaim(['a', 1, 'b'])).toEqual(['a', 'b']);
    expect(groupsFromClaim('a')).toEqual(['a']);
    expect(groupsFromClaim(undefined)).toEqual([]);
  });
  it('hasPermission: exact, area wildcard, global wildcard', () => {
    expect(hasPermission(['keys:read'], 'keys:read')).toBe(true);
    expect(hasPermission(['keys:read'], 'keys:rotate')).toBe(false);
    expect(hasPermission(['keys:*'], 'keys:rotate')).toBe(true);
    expect(hasPermission(['keys:*'], 'users:manage')).toBe(false);
    expect(hasPermission(['*'], 'users:manage')).toBe(true);
    expect(hasPermission(['keys:read'], 'keys:*')).toBe(false);
  });
  it('covers: anti-escalation', () => {
    expect(covers(['*'], ['*'])).toBe(true);
    expect(covers(['keys:*', 'messages:read'], ['keys:rotate', 'messages:read'])).toBe(true);
    expect(covers(['keys:*'], ['keys:*'])).toBe(true);
    expect(covers(['keys:read', 'keys:update'], ['keys:*'])).toBe(false);
    expect(covers(['keys:*'], ['*'])).toBe(false);
    expect(covers(['users:manage'], ['messages:bodies'])).toBe(false);
  });
  it('effective permissions = union; "*" collapses', () => {
    expect(effectivePermissions([{ permissions: ['b', 'a'] }, { permissions: ['a', 'c'] }])).toEqual(['a', 'b', 'c']);
    expect(effectivePermissions([{ permissions: ['keys:read'] }, { permissions: ['*'] }])).toEqual(['*']);
  });
  it('validates permission ids', () => {
    expect(isValidPermission('keys:rotate')).toBe(true);
    expect(isValidPermission('keys:*')).toBe(true);
    expect(isValidPermission('*')).toBe(true);
    expect(isValidPermission('keys:nuke')).toBe(false);
    expect(isValidPermission('bogus:*')).toBe(false);
  });
  it('requires full Authentik config when enabled', () => {
    expect(() => buildConfig({ DATABASE_URL: 'x', AUTHENTIK_ENABLED: 'true' })).toThrow(/AUTHENTIK_ISSUER/);
  });
});

describe('HTML preview hardening', () => {
  it('CSP blocks scripts and remote content by default', () => {
    const csp = previewCsp(false);
    expect(csp).toContain("default-src 'none'");
    expect(csp).not.toContain('script-src');
    expect(csp).toContain('img-src data: cid:;');
    expect(csp).toContain('sandbox');
    expect(previewCsp(true)).toContain('img-src data: cid: https: http:');
  });
  it('removes meta refresh and base tags', () => {
    const out = neutralizeHtml('<meta http-equiv="refresh" content="0;url=https://evil.io"><base href="https://evil.io/"><p>x</p>');
    expect(out).toBe('<p>x</p>');
  });
  it('UI CSP forbids inline scripts and framing', () => {
    expect(UI_CSP).toContain("script-src 'self'");
    expect(UI_CSP).not.toMatch(/script-src[^;]*unsafe-inline/);
    expect(UI_CSP).toContain("frame-ancestors 'none'");
  });
});
