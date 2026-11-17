// Authored by Tomás Neto (TN 2026)
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Stack, createKey, resetState, startStack, uname } from '../helpers/stack';

let s: Stack;
beforeAll(async () => {
  s = await startStack();
  await resetState(s);
});
afterAll(async () => s?.close());

describe('OpenAPI endpoints', () => {
  it('serves /openapi.json, Scalar at /docs (self-hosted, strict CSP) and Swagger UI at /swagger', async () => {
    const spec = await s.http.get('/openapi.json');
    expect(spec.status).toBe(200);
    expect(spec.body.openapi).toMatch(/^3\./);
    expect(spec.body.paths['/v1/send']).toBeDefined();

    const docs = await s.http.get('/docs/');
    expect(docs.status).toBe(200);
    expect(docs.text).toContain('<script src="/docs/scalar.js"></script>');
    expect(docs.text).not.toMatch(/<script>(?!<\/script>)/); // no inline scripts
    expect(docs.text).not.toMatch(/cdn\.|jsdelivr|unpkg/);
    const csp = docs.headers['content-security-policy'];
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("connect-src 'self'");

    const init = await s.http.get('/docs/init.js');
    expect(init.headers['content-type']).toMatch(/javascript/);
    expect(init.text).toContain('"telemetry":false');
    expect(init.text).toContain('"withDefaultFonts":false');
    expect(init.text).toContain('"url":"/openapi.json"');
    const bundle = await s.http.get('/docs/scalar.js');
    expect(bundle.status).toBe(200);
    expect(Number(bundle.headers['content-length'])).toBeGreaterThan(1_000_000);

    const swagger = await s.http.get('/swagger/');
    expect(swagger.status).toBe(200);
    expect(swagger.text).toContain('swagger');
  });
});

describe('health', () => {
  it('live and ready', async () => {
    expect((await s.http.get('/health/live')).body).toEqual({ status: 'ok' });
    const r = await s.http.get('/health/ready');
    expect(r.status).toBe(200);
    expect(r.body.checks).toMatchObject({ postgres: { status: 'up' }, redis: { status: 'up' }, smtp: { status: 'up' } });
  });
  it('ready fails (503) when the SMTP is unreachable', async () => {
    const bad = await startStack({ SMTP_HOST: '127.0.0.1', SMTP_PORT: '1' }, { worker: false });
    try {
      const r = await bad.http.get('/health/ready');
      expect(r.status).toBe(503);
      expect(r.body.checks.smtp.status).toBe('down');
    } finally {
      await bad.close();
    }
  });
});

describe('structured logs', () => {
  it('never contain API keys, admin token or message bodies; rejections are distinct events', async () => {
    const { key, secret } = await createKey(s, { name: uname('logs') });
    const body = 'TOP-SECRET-BODY-CONTENT';
    await s.http.post('/v1/send').set('Authorization', `Bearer ${secret}`).send({ to: 'a@example.com', subject: 'log test', text: body, html: `<b>${body}</b>` });
    await s.http.post('/v1/send').set('Authorization', `Bearer ${secret}`).send({ to: 'x@evil.io', subject: 'log test 2', text: body });
    await new Promise((r) => setTimeout(r, 300));
    expect(s.logs.raw).not.toContain(secret);
    expect(s.logs.raw).not.toContain(s.cfg.ADMIN_TOKEN!);
    expect(s.logs.raw).not.toContain(body);
    const accepted = s.logs.events('message_accepted').find((e) => e.keyName === key.name);
    expect(accepted).toMatchObject({ outcome: 'success', messageId: expect.any(String) });
    const rejected = s.logs.events('policy_rejected').find((e) => e.keyName === key.name);
    expect(rejected).toMatchObject({ event: 'policy_rejected', outcome: 'rejected', reason: 'RECIPIENT_NOT_ALLOWED', messageId: expect.any(String) });
  });
});
