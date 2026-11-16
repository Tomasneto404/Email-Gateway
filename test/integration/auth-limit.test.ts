import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Stack, resetState, startStack } from '../helpers/stack';

let s: Stack;
beforeAll(async () => {
  s = await startStack({ AUTH_FAIL_MAX: '3', TRUST_PROXY: 'true' }, { worker: false });
  await resetState(s);
});
afterAll(async () => s?.close());

describe('failed-auth rate limiting per client IP (trust proxy aware)', () => {
  it('locks out an IP after AUTH_FAIL_MAX failures, other IPs unaffected', async () => {
    const bad = { Authorization: 'Bearer mk_sbx_nope' };
    for (let i = 0; i < 3; i++) {
      expect((await s.http.get('/v1/me').set(bad).set('X-Forwarded-For', '10.9.9.9')).status).toBe(401);
    }
    const locked = await s.http.get('/v1/me').set(bad).set('X-Forwarded-For', '10.9.9.9');
    expect(locked.status).toBe(429);
    expect(locked.body.error.code).toBe('AUTH_RATE_LIMITED');
    expect(Number(locked.headers['retry-after'])).toBeGreaterThan(0);
    expect((await s.http.get('/v1/me').set(bad).set('X-Forwarded-For', '10.1.1.1')).status).toBe(401);
  });
});
