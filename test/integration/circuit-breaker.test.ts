// Authored by Tomás Neto (TN 2026)
import { createServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ADMIN_TOKEN, Stack, createKey, resetState, startStack, uname, waitFor } from '../helpers/stack';

/** A TCP port that is guaranteed closed (bind, read the port, release). */
async function closedPort(): Promise<number> {
  const srv = createServer();
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const port = (srv.address() as AddressInfo).port;
  await new Promise<void>((r) => srv.close(() => r()));
  return port;
}

let s: Stack;
const admin = { Authorization: `Bearer ${ADMIN_TOKEN}` };

beforeAll(async () => {
  s = await startStack({
    SMTP_HOST: '127.0.0.1',
    SMTP_PORT: String(await closedPort()),
    SMTP_TIMEOUT_MS: '2000',
    BREAKER_CONSECUTIVE_FAILURES: '2',
    DELIVERY_MAX_ATTEMPTS: '10',
    DELIVERY_BACKOFF_MS: '100',
  });
  await resetState(s);
});
afterAll(async () => s?.close());

describe('circuit breaker', () => {
  it('pauses the gateway when the SMTP is unreachable; API returns GATEWAY_PAUSED; admin resume', async () => {
    const { secret } = await createKey(s, { name: uname('cb'), mode: 'live' });
    const auth = { Authorization: `Bearer ${secret}` };
    const first = await s.http.post('/v1/send').set(auth).send({ to: 'a@example.com', subject: 'will fail', text: 'x' });
    expect(first.status).toBe(202);

    await waitFor(async () => (await s.http.get('/admin/gateway').set(admin)).body.paused === true, 30_000);
    const state = (await s.http.get('/admin/gateway').set(admin)).body;
    expect(state.reason).toMatch(/^circuit_breaker:smtp/);

    const blocked = await s.http.post('/v1/send').set(auth).send({ to: 'a@example.com', subject: 'after trip', text: 'x' });
    expect(blocked.status).toBe(503);
    expect(blocked.body.error.code).toBe('GATEWAY_PAUSED');

    const msg = await s.prisma.message.findUnique({ where: { id: first.body.id } });
    expect(msg!.status).toBe('queued'); // parked, not lost
    expect(msg!.attempts).toBeGreaterThanOrEqual(2);
    expect(msg!.lastError).toBeTruthy();

    expect(s.logs.events('breaker_tripped')[0]).toMatchObject({ provider: 'smtp', reason: 'consecutive' });
    expect(await s.prisma.adminAudit.count({ where: { action: 'gateway.pause', actorType: 'system' } })).toBeGreaterThan(0);

    const resumed = await s.http.post('/admin/gateway/resume').set(admin);
    expect(resumed.body.paused).toBe(false);
    expect(await s.redis.exists('mg:cb:smtp:state')).toBe(0);
    // Pause again so the still-failing job doesn't keep retrying during teardown.
    await s.http.post('/admin/gateway/pause').set(admin).send({ reason: 'test teardown' });
  });
});
