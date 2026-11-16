import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LoggedIn, PASSWORD, createUser, login, nextCode } from '../helpers/admin-login';
import { ADMIN_TOKEN, Stack, createKey, resetState, startStack, uname, waitFor } from '../helpers/stack';

let s: Stack;
let admin: LoggedIn;

beforeAll(async () => {
  s = await startStack({ LOGIN_MAX_FAILURES: '3' });
  await resetState(s);
  admin = await login(s, 'admin');
});
afterAll(async () => s?.close());

describe('local login: password + mandatory TOTP', () => {
  it('first login requires TOTP enrollment; session only after verification', async () => {
    const { email, id } = await createUser(s, 'admin');
    const agent = request.agent(s.baseUrl);
    const o = { Origin: s.baseUrl };
    const l = await agent.post('/admin/auth/login').set(o).send({ email, password: PASSWORD });
    expect(l.body).toEqual({ next: 'totp_enroll' });
    expect(l.headers['set-cookie'][0]).toMatch(/mg_session=.*HttpOnly.*SameSite=Strict/i);

    // pre-MFA session cannot use the admin API
    const early = await agent.get('/admin/keys');
    expect(early.status).toBe(401);
    expect(early.body.error.code).toBe('MFA_REQUIRED');

    const e = await agent.post('/admin/auth/totp/enroll').set(o).send({});
    expect(e.body.otpauthUri).toMatch(/^otpauth:\/\/totp\//);
    expect(e.body.qrDataUrl).toMatch(/^data:image\/png;base64,/);

    const bad = await agent.post('/admin/auth/totp/verify').set(o).send({ code: '000000' });
    expect(bad.body.error.code).toBe('INVALID_CREDENTIALS');

    const code = await nextCode(s, id);
    const v = await agent.post('/admin/auth/totp/verify').set(o).send({ code });
    expect(v.status).toBe(200);
    expect(v.body.user).toMatchObject({ email, role: 'admin', totpEnrolled: true });
    expect((await agent.get('/admin/keys')).status).toBe(200);

    // replayed code is refused on the next login
    await agent.post('/admin/auth/logout').set(o).send({});
    const l2 = await agent.post('/admin/auth/login').set(o).send({ email, password: PASSWORD });
    expect(l2.body.next).toBe('totp_verify');
    const replay = await agent.post('/admin/auth/totp/verify').set(o).send({ code });
    expect(replay.body.error.code).toBe('INVALID_CREDENTIALS');
    expect(await s.prisma.adminAudit.count({ where: { actorId: id, action: 'auth.login', outcome: 'failure' } })).toBeGreaterThan(0);
  });

  it('wrong password → generic error; lockout after LOGIN_MAX_FAILURES; audited + logged', async () => {
    const { email } = await createUser(s, 'viewer');
    const o = { Origin: s.baseUrl };
    for (let i = 0; i < 3; i++) {
      const r = await request(s.baseUrl).post('/admin/auth/login').set(o).send({ email, password: 'wrong password!!' });
      expect(r.body.error.code).toBe('INVALID_CREDENTIALS');
    }
    const locked = await request(s.baseUrl).post('/admin/auth/login').set(o).send({ email, password: PASSWORD });
    expect(locked.status).toBe(423);
    expect(locked.body.error.code).toBe('ACCOUNT_LOCKED');
    expect(s.logs.events('login_failed').filter((e) => e.user === email)).toHaveLength(3);
    expect(s.logs.raw).not.toContain('wrong password!!');
    expect(s.logs.raw).not.toContain(PASSWORD);
  });

  it('unknown users get the same error as wrong passwords', async () => {
    const r = await request(s.baseUrl).post('/admin/auth/login').set({ Origin: s.baseUrl }).send({ email: 'nobody@admins.test', password: 'whatever whatever' });
    expect(r.body.error.code).toBe('INVALID_CREDENTIALS');
  });

  it('cross-origin login is rejected', async () => {
    const r = await request(s.baseUrl).post('/admin/auth/login').set({ Origin: 'https://evil.example' }).send({ email: 'x@y.z', password: 'x' });
    expect(r.body.error.code).toBe('CSRF_FAILED');
  });
});

describe('CSRF protection on session-authenticated mutations', () => {
  it('requires X-CSRF-Token and same Origin', async () => {
    const noToken = await admin.agent.post('/admin/gateway/pause').set({ Origin: s.baseUrl }).send({ reason: 'x' });
    expect(noToken.status).toBe(403);
    expect(noToken.body.error.code).toBe('CSRF_FAILED');
    const badOrigin = await admin.agent.post('/admin/gateway/pause').set({ Origin: 'https://evil.example', 'X-CSRF-Token': admin.csrf }).send({});
    expect(badOrigin.body.error.code).toBe('CSRF_FAILED');
    const wrongToken = await admin.agent.post('/admin/gateway/pause').set({ Origin: s.baseUrl, 'X-CSRF-Token': 'nope' }).send({});
    expect(wrongToken.body.error.code).toBe('CSRF_FAILED');
    expect((await s.http.get('/admin/gateway').set('Authorization', `Bearer ${ADMIN_TOKEN}`)).body.paused).toBe(false);
  });
});

describe('admin actions via the session take effect immediately and are audited', () => {
  it('promote to live, rotate, pause/resume', async () => {
    const created = await admin.agent.post('/admin/keys').set(admin.h).send({ name: uname('ui'), fromAddress: 'bot@gateway.test', allowedRecipients: ['@example.com'] });
    expect(created.status).toBe(201);
    const id = created.body.key.id;
    const secret = created.body.secret;

    const p = await admin.agent.patch(`/admin/keys/${id}`).set(admin.h).send({ mode: 'live' });
    expect(p.body.mode).toBe('live');
    expect((await s.http.get('/v1/me').set('Authorization', `Bearer ${secret}`)).body.mode).toBe('live');

    const r = await admin.agent.post(`/admin/keys/${id}/rotate`).set(admin.h).send({});
    expect((await s.http.get('/v1/me').set('Authorization', `Bearer ${secret}`)).status).toBe(401);
    expect(r.body.secret).toMatch(/^mk_live_/);

    await admin.agent.post('/admin/gateway/pause').set(admin.h).send({ reason: 'maintenance' });
    const blocked = await s.http.post('/v1/send').set('Authorization', `Bearer ${r.body.secret}`).send({ to: 'a@example.com', subject: 'x', text: 'y' });
    expect(blocked.body.error.code).toBe('GATEWAY_PAUSED');
    await admin.agent.post('/admin/gateway/resume').set(admin.h).send({});

    const acts = await admin.agent.get('/admin/audit').query({ actor: admin.email, pageSize: 50 });
    const actions = acts.body.items.map((a: { action: string }) => a.action);
    expect(actions).toEqual(expect.arrayContaining(['key.create', 'key.promote_live', 'key.rotate', 'gateway.pause', 'gateway.resume', 'auth.login']));
    expect(acts.body.items.every((a: { actorType: string }) => a.actorType === 'user')).toBe(true);
  });

  it('test send from the UI respects the policy and shows up in Messages', async () => {
    const created = await admin.agent.post('/admin/keys').set(admin.h).send({ name: uname('ts'), fromAddress: 'bot@gateway.test', allowedRecipients: ['@example.com'] });
    const id = created.body.key.id;
    const denied = await admin.agent.post(`/admin/keys/${id}/test-send`).set(admin.h).send({ to: 'x@evil.io' });
    expect(denied.body.error.code).toBe('RECIPIENT_NOT_ALLOWED');
    const ok = await admin.agent.post(`/admin/keys/${id}/test-send`).set(admin.h).send({ to: 'ui@example.com' });
    expect(ok.status).toBe(202);
    await waitFor(async () => (await admin.agent.get(`/admin/messages/${ok.body.id}`)).body.status === 'captured');
    const list = await admin.agent.get('/admin/messages').query({ keyId: id });
    expect(list.body.items.map((m: { source: string }) => m.source)).toEqual(['admin_test', 'admin_test']);
  });
});

describe('viewer role', () => {
  it('cannot change anything and cannot see bodies', async () => {
    const viewer = await login(s, 'viewer');
    const { secret } = await createKey(s, { name: uname('vw') });
    const sent = await s.http.post('/v1/send').set('Authorization', `Bearer ${secret}`).send({ to: 'a@example.com', subject: 'v', text: 'hidden body', html: '<p>hidden</p>' });

    expect((await viewer.agent.get('/admin/keys')).status).toBe(200);
    for (const [method, path, body] of [
      ['post', '/admin/keys', { name: uname('nope'), fromAddress: 'a@example.com' }],
      ['post', '/admin/gateway/pause', {}],
      ['post', `/admin/messages/${sent.body.id}/approve`, {}],
      ['patch', `/admin/users/${viewer.userId}`, { role: 'admin' }],
    ] as const) {
      const r = await viewer.agent[method](path).set(viewer.h).send(body);
      expect({ path, status: r.status, code: r.body.error?.code }).toEqual({ path, status: 403, code: 'FORBIDDEN' });
    }
    expect((await viewer.agent.get('/admin/users')).status).toBe(403);

    const d = await viewer.agent.get(`/admin/messages/${sent.body.id}`);
    expect(d.body).toMatchObject({ bodiesVisible: false, textBody: null, htmlBody: null, hasHtml: true });
    expect((await viewer.agent.get(`/admin/messages/${sent.body.id}/preview`)).status).toBe(403);
  });

  it('with canViewBodies sees bodies', async () => {
    const viewer = await login(s, 'viewer', true);
    const { secret } = await createKey(s, { name: uname('vb') });
    const sent = await s.http.post('/v1/send').set('Authorization', `Bearer ${secret}`).send({ to: 'a@example.com', subject: 'v', text: 'visible body' });
    const d = await viewer.agent.get(`/admin/messages/${sent.body.id}`);
    expect(d.body).toMatchObject({ bodiesVisible: true, textBody: 'visible body' });
  });
});

describe('HTML preview', () => {
  it('is served with a sandboxing CSP; remote images only when toggled', async () => {
    const { secret } = await createKey(s, { name: uname('pv') });
    const html = '<script>alert(1)</script><img src="https://tracker.example/p.gif"><meta http-equiv="refresh" content="0;url=https://evil.io">';
    const sent = await s.http.post('/v1/send').set('Authorization', `Bearer ${secret}`).send({ to: 'a@example.com', subject: 'pv', html });
    const r = await admin.agent.get(`/admin/messages/${sent.body.id}/preview`);
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toMatch(/text\/html/);
    expect(r.headers['content-security-policy']).toContain("default-src 'none'");
    expect(r.headers['content-security-policy']).toContain('img-src data: cid:;');
    expect(r.headers['content-security-policy']).toContain('sandbox');
    expect(r.text).not.toContain('http-equiv="refresh"');
    const remote = await admin.agent.get(`/admin/messages/${sent.body.id}/preview`).query({ remoteImages: '1' });
    expect(remote.headers['content-security-policy']).toContain('img-src data: cid: https: http:');
  });
});

describe('users management + invites', () => {
  it('invite → set password → login with TOTP; cannot remove last admin; disabling kills sessions', async () => {
    const inv = await admin.agent.post('/admin/users').set(admin.h).send({ email: `${uname('inv')}@admins.test`, role: 'viewer' });
    expect(inv.status).toBe(201);
    const token = inv.body.invitePath.split('/').pop();
    const info = await request(s.baseUrl).get(`/admin/auth/invite/${token}`);
    expect(info.body.email).toBe(inv.body.user.email);
    const weak = await request(s.baseUrl).post(`/admin/auth/invite/${token}`).set({ Origin: s.baseUrl }).send({ password: 'short' });
    expect(weak.body.error.code).toBe('VALIDATION_FAILED');
    expect((await request(s.baseUrl).post(`/admin/auth/invite/${token}`).set({ Origin: s.baseUrl }).send({ password: PASSWORD })).status).toBe(200);
    // invite is single-use
    expect((await request(s.baseUrl).get(`/admin/auth/invite/${token}`)).body.error.code).toBe('INVITE_INVALID');

    const l = await request(s.baseUrl).post('/admin/auth/login').set({ Origin: s.baseUrl }).send({ email: inv.body.user.email, password: PASSWORD });
    expect(l.body.next).toBe('totp_enroll');

    const self = await admin.agent.patch(`/admin/users/${admin.userId}`).set(admin.h).send({ disabled: true });
    expect(self.body.error.code).toBe('INVALID_STATE');

    const other = await login(s, 'viewer');
    expect((await other.agent.get('/admin/keys')).status).toBe(200);
    await admin.agent.patch(`/admin/users/${other.userId}`).set(admin.h).send({ disabled: true });
    expect((await other.agent.get('/admin/keys')).status).toBe(401);
  });
});

describe('dashboard endpoints', () => {
  it('stats overview + system state', async () => {
    const o = await admin.agent.get('/admin/stats/overview').query({ bucket: 'hour' });
    expect(o.status).toBe(200);
    expect(o.body.series.length).toBeGreaterThanOrEqual(24);
    expect(o.body.totals.accepted).toBeGreaterThan(0);
    expect(o.body.rejectionsByReason.some((r: { reason: string }) => r.reason === 'RECIPIENT_NOT_ALLOWED')).toBe(true);
    expect(o.body.topKeys.length).toBeGreaterThan(0);
    const sys = await admin.agent.get('/admin/stats/system');
    expect(sys.body).toMatchObject({ gateway: { paused: false }, smtpHealth: { status: 'up' } });
    expect(sys.body.breakers.map((b: { provider: string }) => b.provider)).toEqual(['smtp', 'resend']);
    const settings = await admin.agent.get('/admin/settings');
    expect(settings.body.smtp).toMatchObject({ enabled: true });
    expect(JSON.stringify(settings.body)).not.toContain(s.cfg.ADMIN_TOKEN!);
  });
});

describe('static admin token is for automation only', () => {
  it('is rejected when ADMIN_TOKEN_ENABLED=false', async () => {
    const off = await startStack({ ADMIN_TOKEN_ENABLED: 'false' }, { worker: false });
    try {
      expect((await off.http.get('/admin/keys').set('Authorization', `Bearer ${ADMIN_TOKEN}`)).status).toBe(401);
    } finally {
      await off.close();
    }
  });
});
