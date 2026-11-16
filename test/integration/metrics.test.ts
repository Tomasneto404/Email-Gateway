import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OpsServer } from '../../src/metrics/ops-server';
import { Stack, createKey, resetState, startStack, uname, waitFor } from '../helpers/stack';

let s: Stack;
let base: string;
beforeAll(async () => {
  s = await startStack({}, { opsServer: true });
  await resetState(s);
  base = `http://127.0.0.1:${s.api.get(OpsServer).port}`;
});
afterAll(async () => s?.close());

describe('Prometheus metrics (internal port)', () => {
  it('exposes messages, rejections, queue depth, gateway state; not on the public port', async () => {
    const { key, secret } = await createKey(s, { name: uname('met') });
    const auth = { Authorization: `Bearer ${secret}` };
    const ok = await s.http.post('/v1/send').set(auth).send({ to: 'a@example.com', subject: 'm1', text: 'x' });
    await s.http.post('/v1/send').set(auth).send({ to: 'x@evil.io', subject: 'm2', text: 'x' });
    await s.http.get('/v1/me').set({ Authorization: 'Bearer nope' });
    await waitFor(async () => (await s.http.get(`/v1/messages/${ok.body.id}`).set(auth)).body.status === 'captured');

    const text = await (await fetch(`${base}/metrics`)).text();
    expect(text).toContain(`mg_messages_total{status="queued",key="${key.name}"} 1`);
    expect(text).toContain(`mg_rejections_total{reason="RECIPIENT_NOT_ALLOWED",key="${key.name}"} 1`);
    expect(text).toMatch(/mg_auth_failures_total\{reason="INVALID_API_KEY"\} \d+/);
    expect(text).toMatch(/mg_queue_depth\{state="waiting"\} \d+/);
    expect(text).toContain('mg_gateway_paused 0');
    expect(text).toMatch(/mg_process_/);

    expect((await s.http.get('/metrics')).status).toBe(404);
  });

  it('serves health on the internal port too', async () => {
    expect((await fetch(`${base}/health/live`)).status).toBe(200);
    expect((await fetch(`${base}/health/ready`)).status).toBe(200);
  });
});
