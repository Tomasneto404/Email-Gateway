// Authored by Tomás Neto (TN 2026)
import { createHmac } from 'node:crypto';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AlertsService } from '../../src/alerts/alerts.service';
import { AlertsWorker } from '../../src/alerts/alerts.worker';
import { SecretBox } from '../../src/auth/crypto';
import { EventLogger } from '../../src/common/event-logger';
import { QuotaService } from '../../src/policy/quota.service';
import { QueueService } from '../../src/queue/queue.service';
import { PASSWORD, createUser, login } from '../helpers/admin-login';
import { ADMIN_TOKEN, Stack, createKey, resetState, startStack, uname, waitFor } from '../helpers/stack';

// No worker in this file: nothing is ever delivered. Accepted sends use approval-mode keys (held
// as pending_approval); everything else exercises rejections and admin endpoints.
let s: Stack;
const admin = { Authorization: `Bearer ${ADMIN_TOKEN}` };
const auth = (secret: string) => ({ Authorization: `Bearer ${secret}` });

let hook: Server;
let hookUrl = '';
const received: Array<{ headers: IncomingHttpHeaders; body: string }> = [];

beforeAll(async () => {
  s = await startStack(
    {
      RECIPIENT_DOMAIN_LIMITS: 'example.org=2',
      WARMUP_SCHEDULE: '3,10',
      ALERT_REJECTION_SPIKE: '3',
      ALERT_SPIKE_WINDOW_MINUTES: '60',
    },
    { worker: false },
  );
  await resetState(s);
  hook = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      received.push({ headers: req.headers, body });
      res.writeHead(204).end();
    });
  });
  await new Promise<void>((r) => hook.listen(0, '127.0.0.1', () => r()));
  hookUrl = `http://127.0.0.1:${(hook.address() as { port: number }).port}/hook`;
}, 120_000);

afterAll(async () => {
  await new Promise<void>((r) => hook.close(() => r()));
  await s?.close();
});

describe('key access controls', () => {
  it('restricts source IPs', async () => {
    const { key, secret } = await createKey(s, { name: uname('ip'), allowedIps: ['10.9.9.9', '192.168.0.0/16'] });
    const denied = await s.http.get('/v1/me').set(auth(secret));
    expect(denied.status).toBe(403);
    expect(denied.body.error.code).toBe('IP_NOT_ALLOWED');
    await s.http.patch(`/admin/keys/${key.id}`).set(admin).send({ allowedIps: ['127.0.0.0/8'] }).expect(200);
    const ok = await s.http.get('/v1/me').set(auth(secret)).expect(200);
    expect(ok.body).not.toHaveProperty('allowedIps');
    const bad = await s.http.patch(`/admin/keys/${key.id}`).set(admin).send({ allowedIps: ['10.0.0.0/40'] });
    expect(bad.body.error.code).toBe('VALIDATION_FAILED');
  });

  it('stops expired keys', async () => {
    const { key, secret } = await createKey(s, { name: uname('exp'), expiresAt: new Date(Date.now() + 3600_000).toISOString() });
    await s.http.get('/v1/me').set(auth(secret)).expect(200);
    await s.http.patch(`/admin/keys/${key.id}`).set(admin).send({ expiresAt: new Date(Date.now() - 1000).toISOString() }).expect(200);
    const r = await s.http.get('/v1/me').set(auth(secret));
    expect(r.status).toBe(401);
    expect(r.body.error.code).toBe('KEY_EXPIRED');
  });

  it('keeps the previous secret during the rotation grace period only', async () => {
    const { key, secret: first } = await createKey(s, { name: uname('rot') });
    const r1 = await s.http.post(`/admin/keys/${key.id}/rotate`).set(admin).send({ graceMinutes: 30 }).expect(200);
    const me = await s.http.get('/v1/me').set(auth(first)).expect(200);
    expect(new Date(me.body.previousSecretValidUntil).getTime()).toBeGreaterThan(Date.now() + 29 * 60_000);
    await s.http.get('/v1/me').set(auth(r1.body.secret)).expect(200);
    const r2 = await s.http.post(`/admin/keys/${key.id}/rotate`).set(admin).send({}).expect(200);
    expect((await s.http.get('/v1/me').set(auth(first))).status).toBe(401);
    expect((await s.http.get('/v1/me').set(auth(r1.body.secret))).status).toBe(401);
    await s.http.get('/v1/me').set(auth(r2.body.secret)).expect(200);
  });
});

describe('templates', () => {
  let tplId = '';
  const tplName = uname('reset');

  it('renders server-side templates and enforces templatesOnly', async () => {
    const t = await s.http
      .post('/admin/templates')
      .set(admin)
      .send({ name: tplName, description: 'Password reset', subject: 'Reset for {{name}}', text: 'Code {{code}}', html: '<p>Code <b>{{code}}</b></p>' })
      .expect(201);
    tplId = t.body.id;
    expect(t.body.variables).toEqual(['code', 'name']);

    const { secret } = await createKey(s, { name: uname('tpl'), mode: 'approval', templatesOnly: true, allowedTemplates: [tplName] });
    const list = await s.http.get('/v1/templates').set(auth(secret)).expect(200);
    expect(list.body).toEqual([expect.objectContaining({ name: tplName, variables: ['code', 'name'] })]);

    const free = await s.http.post('/v1/send').set(auth(secret)).send({ to: 'a@example.com', subject: 'x', text: 'y' });
    expect(free.body.error.code).toBe('TEMPLATE_REQUIRED');
    const missing = await s.http.post('/v1/send').set(auth(secret)).send({ to: 'a@example.com', template: tplName, variables: { name: 'Ana' } });
    expect(missing.body.error.code).toBe('VALIDATION_FAILED');
    expect(missing.body.error.message).toMatch(/Missing template variables: code/);
    const mixed = await s.http.post('/v1/send').set(auth(secret)).send({ to: 'a@example.com', template: tplName, subject: 'x', variables: { name: 'A', code: 1 } });
    expect(mixed.body.error.code).toBe('VALIDATION_FAILED');

    const ok = await s.http.post('/v1/send').set(auth(secret)).send({ to: 'a@example.com', template: tplName, variables: { name: 'Ana <x>', code: 424242 } }).expect(202);
    expect(ok.body.status).toBe('pending_approval');
    const row = await s.prisma.message.findUniqueOrThrow({ where: { id: ok.body.id } });
    expect(row).toMatchObject({ subject: 'Reset for Ana <x>', templateName: tplName });
  });

  it('refuses templates the key does not allow, and deleting a template in use', async () => {
    const other = await s.http.post('/admin/templates').set(admin).send({ name: uname('other'), subject: 'Hi', text: 'Hi' }).expect(201);
    const { secret } = await createKey(s, { name: uname('tpl2'), mode: 'approval', allowedTemplates: [tplName] });
    const r = await s.http.post('/v1/send').set(auth(secret)).send({ to: 'a@example.com', template: other.body.name });
    expect(r.body.error.code).toBe('TEMPLATE_NOT_ALLOWED');
    const del = await s.http.delete(`/admin/templates/${tplId}`).set(admin);
    expect(del.status).toBe(409);
    await s.http.delete(`/admin/templates/${other.body.id}`).set(admin).expect(204);
  });
});

describe('content guardrails', () => {
  it('refuses links to other domains, secrets and disguised executables', async () => {
    const { secret } = await createKey(s, { name: uname('content'), allowedLinkDomains: ['example.com'], attachmentsAllowed: true });
    const send = (body: Record<string, unknown>) => s.http.post('/v1/send').set(auth(secret)).send({ to: 'a@example.com', subject: uname('c'), ...body });
    expect((await send({ html: '<a href="https://login.evil.net">sign in</a>' })).body.error.code).toBe('LINK_NOT_ALLOWED');
    expect((await send({ text: 'aws key AKIAIOSFODNN7EXAMPLE' })).body.error.code).toBe('CONTENT_BLOCKED');
    const exe = Buffer.concat([Buffer.from('MZ'), Buffer.alloc(64)]).toString('base64');
    const att = await send({ text: 'see attached', attachments: [{ filename: 'invoice.pdf', contentType: 'application/pdf', content: exe }] });
    expect(att.status).toBe(415);
    expect(att.body.error.code).toBe('ATTACHMENT_TYPE_NOT_ALLOWED');
    const rejected = await s.prisma.message.findMany({ where: { apiKey: { name: { startsWith: 'content' } }, status: 'rejected' } });
    expect(rejected.map((m) => m.rejectCode)).toEqual(expect.arrayContaining(['LINK_NOT_ALLOWED', 'CONTENT_BLOCKED', 'ATTACHMENT_TYPE_NOT_ALLOWED']));
  });
});

describe('volume limits', () => {
  it('caps recipients per destination domain across keys', async () => {
    const a = await createKey(s, { name: uname('doma'), mode: 'approval', allowedRecipients: ['@example.org'], warmup: false });
    const b = await createKey(s, { name: uname('domb'), mode: 'approval', allowedRecipients: ['@example.org'], warmup: false });
    await s.http.post('/v1/send').set(auth(a.secret)).send({ to: ['x@example.org', 'y@example.org'], subject: uname('d'), text: 'x' }).expect(202);
    const over = await s.http.post('/v1/send').set(auth(b.secret)).send({ to: 'z@example.org', subject: uname('d'), text: 'x' });
    expect(over.status).toBe(429);
    expect(over.body.error).toMatchObject({ code: 'DOMAIN_RATE_LIMITED', details: { domain: 'example.org', limit: 2 } });
  });

  it('warms up keys that just left sandbox', async () => {
    const { key, secret } = await createKey(s, { name: uname('warm'), quotaPerDay: 100 });
    await s.http.patch(`/admin/keys/${key.id}`).set(admin).send({ mode: 'approval' }).expect(200);
    const view = await s.http.get(`/admin/keys/${key.id}`).set(admin).expect(200);
    expect(view.body.warmupState).toEqual({ day: 1, days: 2, dailyCap: 3 });
    const me = await s.http.get('/v1/me').set(auth(secret)).expect(200);
    expect(me.body.usage.day.limit).toBe(3);
    for (let i = 0; i < 3; i++) await s.http.post('/v1/send').set(auth(secret)).send({ to: 'a@example.com', subject: uname('w'), text: 'x' }).expect(202);
    const fourth = await s.http.post('/v1/send').set(auth(secret)).send({ to: 'a@example.com', subject: uname('w'), text: 'x' });
    expect(fourth.body.error.code).toBe('QUOTA_EXCEEDED');
    expect(fourth.body.error.message).toMatch(/warming up \(day 1 of 2\)/);
  });
});

describe('message bodies at rest', () => {
  it('are encrypted in the database and readable through the admin API', async () => {
    const { secret } = await createKey(s, { name: uname('enc'), mode: 'approval' });
    const r = await s.http.post('/v1/send').set(auth(secret)).send({ to: 'a@example.com', subject: uname('e'), text: 'very private text', html: '<p>private html</p>' }).expect(202);
    const raw = await s.prisma.$queryRaw<Array<{ text_body: string; html_body: string }>>`SELECT text_body, html_body FROM messages WHERE id = ${r.body.id}::uuid`;
    expect(raw[0].text_body.startsWith('enc:v1:')).toBe(true);
    expect(raw[0].text_body).not.toContain('private');
    const detail = await s.http.get(`/admin/messages/${r.body.id}`).set(admin).expect(200);
    expect(detail.body).toMatchObject({ textBody: 'very private text', htmlBody: '<p>private html</p>' });
    const preview = await s.http.get(`/admin/messages/${r.body.id}/preview`).set(admin).expect(200);
    expect(preview.text).toContain('private html');
  });
});

describe('account security', () => {
  it('changes the password and signs out other sessions', async () => {
    const a = await login(s, 'admin');
    const other = request.agent(s.baseUrl);
    await other.post('/admin/auth/login').set({ Origin: s.baseUrl }).send({ email: a.email, password: PASSWORD }).expect(200);
    const sessions = await a.agent.get('/admin/account/sessions').expect(200);
    expect(sessions.body.length).toBe(2);
    expect(sessions.body.filter((x: { current: boolean }) => x.current)).toHaveLength(1);

    const wrong = await a.agent.post('/admin/account/password').set(a.h).send({ currentPassword: 'nope', newPassword: 'another long password' });
    expect(wrong.body.error.code).toBe('INVALID_CREDENTIALS');
    const short = await a.agent.post('/admin/account/password').set(a.h).send({ currentPassword: PASSWORD, newPassword: 'short' });
    expect(short.body.error.code).toBe('VALIDATION_FAILED');
    const ok = await a.agent.post('/admin/account/password').set(a.h).send({ currentPassword: PASSWORD, newPassword: 'another long password' }).expect(200);
    expect(ok.body.otherSessionsRevoked).toBe(1);
    await other.get('/admin/auth/session').expect(401);
    await a.agent.get('/admin/auth/session').expect(200);
    const relog = await request(s.baseUrl).post('/admin/auth/login').set({ Origin: s.baseUrl }).send({ email: a.email, password: 'another long password' });
    expect(relog.body.next).toBe('done');
  });

  it('does not let a password alone replace the passkey with a freshly enrolled TOTP', async () => {
    const { email, id } = await createUser(s, 'admin');
    await s.prisma.adminPasskey.create({ data: { userId: id, credentialId: uname('cred'), publicKey: new Uint8Array([1, 2, 3]), name: 'Laptop' } });
    const attacker = request.agent(s.baseUrl);
    const o = { Origin: s.baseUrl };
    const l = await attacker.post('/admin/auth/login').set(o).send({ email, password: PASSWORD }).expect(200);
    expect(l.body).toEqual({ next: 'second_factor', methods: ['passkey'] });
    const enroll = await attacker.post('/admin/auth/totp/enroll').set(o).send({});
    expect(enroll.body.error.code).toBe('INVALID_STATE');
    // even with a secret planted some other way, verify must not complete an enrollment
    await s.prisma.adminUser.update({ where: { id }, data: { totpSecretEnc: s.api.get(SecretBox).seal('JBSWY3DPEHPK3PXP') } });
    const verify = await attacker.post('/admin/auth/totp/verify').set(o).send({ code: '123456' });
    expect(verify.body.error.code).toBe('INVALID_STATE');
    const sess = await attacker.get('/admin/auth/session');
    expect(sess.body.error.code).toBe('MFA_REQUIRED');
    expect((await s.prisma.adminUser.findUniqueOrThrow({ where: { id } })).totpEnrolled).toBe(false);
  });

  it('offers passkey registration and lists none yet', async () => {
    const a = await login(s, 'admin');
    await a.agent.get('/admin/account/passkeys').expect(200, []);
    const opts = await a.agent.post('/admin/account/passkeys/options').set(a.h).send({}).expect(200);
    expect(opts.body).toMatchObject({ rp: { name: 'mail-gateway', id: '127.0.0.1' }, user: { name: a.email } });
    expect(typeof opts.body.challenge).toBe('string');
    const bad = await a.agent.post('/admin/account/passkeys').set(a.h).send({ response: { id: 'x', rawId: 'x', type: 'public-key', response: {} } });
    expect(bad.body.error.code).toBe('VALIDATION_FAILED');
  });
});

describe('alerts', () => {
  it('delivers HMAC-signed webhooks and evaluates rules', async () => {
    const created = await s.http.post('/admin/alerts/channels').set(admin).send({ name: uname('hook'), type: 'webhook', target: hookUrl, events: ['*'] }).expect(201);
    const secret = created.body.signingSecret as string;
    expect(secret).toBeTruthy();
    expect(created.body.channel.targetPreview).toBe(`http://127.0.0.1:${new URL(hookUrl).port}/…`);

    // The worker is not running here: deliver with the worker's own code.
    const worker = new AlertsWorker(s.cfg, s.prisma, s.api.get(SecretBox), s.api.get(QueueService), s.api.get(AlertsService), new QuotaService(s.redis, s.cfg), s.api.get(EventLogger));
    const { eventId } = (await s.http.post(`/admin/alerts/channels/${created.body.channel.id}/test`).set(admin).expect(202)).body;
    await worker.deliver({ data: { eventId }, attemptsMade: 0, opts: { attempts: 1 } } as never);
    const got = received.at(-1)!;
    expect(JSON.parse(got.body)).toMatchObject({ type: 'test', severity: 'info' });
    const ts = got.headers['x-mail-gateway-timestamp'] as string;
    expect(got.headers['x-mail-gateway-signature']).toBe(`sha256=${createHmac('sha256', secret).update(`${ts}.${got.body}`).digest('hex')}`);

    // Rejection spike rule (threshold 3 in this file; earlier tests produced rejections).
    await worker.scan();
    const spike = await s.prisma.alertEvent.findFirst({ where: { type: 'rejection_spike' } });
    expect(spike?.title).toMatch(/requests rejected/);
    await worker.scan(); // cooldown: no duplicate
    expect(await s.prisma.alertEvent.count({ where: { type: 'rejection_spike' } })).toBe(1);

    const history = await s.http.get('/admin/alerts/events').set(admin).expect(200);
    expect(history.body.items.find((e: { id: string }) => e.id === eventId).deliveredTo).toEqual([created.body.channel.name]);
  });

  it('raises an alert when the gateway is paused', async () => {
    await s.http.post('/admin/gateway/pause').set(admin).send({ reason: 'maintenance' }).expect(200);
    await waitFor(() => s.prisma.alertEvent.findFirst({ where: { type: 'gateway_paused' } }));
    await s.http.post('/admin/gateway/resume').set(admin).expect(200);
  });
});

describe('dashboard', () => {
  it('returns the previous period totals', async () => {
    const r = await s.http.get('/admin/stats/overview').set(admin).expect(200);
    expect(r.body.previousTotals).toEqual({ accepted: expect.any(Number), sent: 0, captured: 0, failed: 0, rejected: expect.any(Number) });
    const bad = await s.http.get('/admin/stats/overview?keyId=undefined').set(admin);
    expect(bad.status).toBe(400);
  });
});

// Last: tampering breaks the chain for the rest of the file.
describe('tamper-evident activity log', () => {
  it('verifies, then detects an edited row and alerts', async () => {
    const ok = await s.http.get('/admin/audit/verify').set(admin).expect(200);
    expect(ok.body).toMatchObject({ ok: true, brokenAtSeq: null });
    expect(ok.body.checked).toBeGreaterThan(5);
    expect(ok.body.headHash).toMatch(/^hmac:/);

    const victim = await s.prisma.adminAudit.findFirstOrThrow({ where: { action: 'key.create' }, orderBy: { seq: 'asc' } });
    await s.prisma.adminAudit.update({ where: { id: victim.id }, data: { actorLabel: 'someone-else' } });
    const bad = await s.http.get('/admin/audit/verify').set(admin).expect(200);
    expect(bad.body).toMatchObject({ ok: false, brokenAtSeq: String(victim.seq) });
    expect(bad.body.reason).toMatch(/modified/);
    expect(await s.prisma.alertEvent.findFirst({ where: { type: 'audit_chain_broken' } })).toBeTruthy();
  });
});
