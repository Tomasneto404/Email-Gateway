// Authored by Tomás Neto (TN 2026)
import { describe, expect, it } from 'vitest';
import { buildConfig } from '../../src/config/config';

const base = {
  DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
  REDIS_URL: 'redis://localhost:6379',
} as NodeJS.ProcessEnv;

const sso = {
  ...base,
  AUTHENTIK_ENABLED: 'true',
  AUTHENTIK_ISSUER: 'https://authentik.example.com/application/o/mail-gateway/',
  AUTHENTIK_CLIENT_ID: 'client',
  AUTHENTIK_CLIENT_SECRET: 'secret',
} as NodeJS.ProcessEnv;

describe('PUBLIC_URL validation', () => {
  it('accepts an absolute http(s) origin, with or without a trailing slash', () => {
    expect(buildConfig({ ...sso, PUBLIC_URL: 'http://localhost:3000' }).PUBLIC_URL).toBe('http://localhost:3000');
    expect(() => buildConfig({ ...sso, PUBLIC_URL: 'https://mail-gw.example.com/' })).not.toThrow();
  });

  it.each(['localhost:3000', 'mail-gw.example.com', 'ftp://mail-gw.example.com', 'https://mail-gw.example.com/ui'])('rejects %s at startup instead of failing at sign-in', (v) => {
    expect(() => buildConfig({ ...base, PUBLIC_URL: v })).toThrow(/PUBLIC_URL: must be an absolute http\(s\) URL/);
  });

  it('still requires PUBLIC_URL when Authentik is enabled', () => {
    expect(() => buildConfig(sso)).toThrow(/PUBLIC_URL: required when AUTHENTIK_ENABLED=true/);
  });

  it('rejects an issuer without a scheme', () => {
    expect(() => buildConfig({ ...sso, PUBLIC_URL: 'http://localhost:3000', AUTHENTIK_ISSUER: 'authentik.example.com/application/o/x/' })).toThrow(/AUTHENTIK_ISSUER: must start with https/);
  });
});
