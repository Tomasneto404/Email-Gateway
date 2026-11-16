import { createServer, Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Webhook } from 'svix';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Stack, createKey, resetState, startStack, uname, waitFor } from '../helpers/stack';

const WEBHOOK_SECRET = 'whsec_' + Buffer.from('test-webhook-secret-32-bytes!!!!').toString('base64');
let s: Stack;
let stub: Server;
const calls: Array<{ idem?: string; body: Record<string, unknown> }> = [];

beforeAll(async () => {
  stub = createServer((req, res) => {
    let d = '';
    req.on('data', (c) => (d += c));
    req.on('end', () => {
      calls.push({ idem: req.headers['idempotency-key'] as string, body: JSON.parse(d) });
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ id: `re_${calls.length}` }));
    });
  });
  await new Promise<void>((r) => stub.listen(0, '127.0.0.1', r));
  s = await startStack({
    RESEND_ENABLED: 'true',
    RESEND_API_KEY: 're_test_123',
    RESEND_BASE_URL: `http://127.0.0.1:${(stub.address() as AddressInfo).port}`,
    RESEND_WEBHOOK_SECRET: WEBHOOK_SECRET,
  });
  await resetState(s);
});
afterAll(async () => {
  await s?.close();
  await new Promise<void>((r) => stub.close(() => r()));
});

function signed(payload: object) {
  const body = JSON.stringify(payload);
  const id = `msg_${Date.now()}`;
  const ts = new Date();
  const sig = new Webhook(WEBHOOK_SECRET).sign(id, ts, body);
  return { body, headers: { 'svix-id': id, 'svix-timestamp': String(Math.floor(ts.getTime() / 1000)), 'svix-signature': sig, 'content-type': 'application/json' } };
}

describe('Resend provider + webhooks', () => {
  it('delivers via Resend with idempotency and records bounce webhooks', async () => {
    const { key, secret } = await createKey(s, { name: uname('rs'), mode: 'live', liveProvider: 'resend' });
    const r = await s.http.post('/v1/send').set({ Authorization: `Bearer ${secret}` }).send({ to: 'a@example.com', subject: 'via resend', text: 'x' });
    expect(r.status).toBe(202);
    const msg = await waitFor(async () => {
      const m = await s.prisma.message.findUnique({ where: { id: r.body.id } });
      return m?.status === 'sent' ? m : null;
    });
    expect(msg.provider).toBe('resend');
    const call = calls.at(-1)!;
    expect(call.idem).toBe(r.body.id);
    expect(call.body.headers).toMatchObject({ 'X-Mail-Gateway-Key': key.name, 'X-Mail-Gateway-Message-Id': r.body.id });

    const evt = signed({ type: 'email.bounced', created_at: new Date().toISOString(), data: { email_id: msg.providerMessageId, bounce: { type: 'Permanent' } } });
    const wh = await s.http.post('/webhooks/resend').set(evt.headers).send(evt.body);
    expect(wh.status).toBe(200);
    const after = await s.prisma.message.findUnique({ where: { id: r.body.id } });
    expect(after!.deliveryOutcome).toBe('bounced');

    // a later "delivered" does not hide the bounce
    const d = signed({ type: 'email.delivered', data: { email_id: msg.providerMessageId } });
    await s.http.post('/webhooks/resend').set(d.headers).send(d.body);
    expect((await s.prisma.message.findUnique({ where: { id: r.body.id } }))!.deliveryOutcome).toBe('bounced');
    expect(s.logs.events('provider_event').some((e) => e.deliveryOutcome === 'bounced')).toBe(true);
  });

  it('rejects webhooks with a bad signature', async () => {
    const evt = signed({ type: 'email.delivered', data: { email_id: 'x' } });
    const r = await s.http.post('/webhooks/resend').set({ ...evt.headers, 'svix-signature': 'v1,AAAA' }).send(evt.body);
    expect(r.status).toBe(401);
  });

  it('PROVIDER_UNAVAILABLE when a key points at a disabled provider', async () => {
    const s2 = await startStack({ RESEND_ENABLED: 'false' }, { worker: false });
    try {
      const { secret } = await createKey(s2, { name: uname('rsx'), mode: 'live', liveProvider: 'resend' });
      const r = await s2.http.post('/v1/send').set({ Authorization: `Bearer ${secret}` }).send({ to: 'a@example.com', subject: 'x', text: 'y' });
      expect(r.status).toBe(503);
      expect(r.body.error.code).toBe('PROVIDER_UNAVAILABLE');
    } finally {
      await s2.close();
    }
  });
});
