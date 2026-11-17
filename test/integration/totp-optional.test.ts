import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SecretBox } from '../../src/auth/crypto';
import { totp, totpStep } from '../../src/auth/totp';
import { PASSWORD, createUser, login, nextCode } from '../helpers/admin-login';
import { Stack, resetState, startStack } from '../helpers/stack';

let s: Stack;
beforeAll(async () => {
  s = await startStack({}, { worker: false }); // TOTP_REQUIRED defaults to false
  await resetState(s);
});
afterAll(async () => s?.close());

const o = () => ({ Origin: s.baseUrl });

describe('optional TOTP (default)', () => {
  it('advertises the policy', async () => {
    expect((await s.http.get('/admin/auth/config')).body).toMatchObject({ totpRequired: false });
  });

  it('password-only login signs in directly (audited as method=password)', async () => {
    const { email, id } = await createUser(s, 'admin');
    const agent = request.agent(s.baseUrl);
    const l = await agent.post('/admin/auth/login').set(o()).send({ email, password: PASSWORD });
    expect(l.body).toMatchObject({ next: 'done', user: { email, totpEnrolled: false }, csrfToken: expect.any(String) });
    expect((await agent.get('/admin/keys')).status).toBe(200);
    const audit = await s.prisma.adminAudit.findFirst({ where: { actorId: id, action: 'auth.login' } });
    expect(audit?.details).toMatchObject({ method: 'password' });
  });

  it('user enables 2FA → next login requires the code; disabling needs the password', async () => {
    const me = await login(s, 'viewer'); // viewers manage their own 2FA too
    const setup = await me.agent.post('/admin/account/totp/setup').set(me.h).send({});
    expect(setup.status).toBe(200);
    expect(setup.body.qrDataUrl).toMatch(/^data:image\/png/);

    // not active until confirmed
    expect((await request(s.baseUrl).post('/admin/auth/login').set(o()).send({ email: me.email, password: PASSWORD })).body.next).toBe('done');

    const bad = await me.agent.post('/admin/account/totp/confirm').set(me.h).send({ code: '000000' });
    expect(bad.body.error.code).toBe('INVALID_CREDENTIALS');
    const ok = await me.agent.post('/admin/account/totp/confirm').set(me.h).send({ code: totp(setup.body.secret) });
    expect(ok.body.totpEnrolled).toBe(true);

    // now login requires the code
    const agent = request.agent(s.baseUrl);
    const l = await agent.post('/admin/auth/login').set(o()).send({ email: me.email, password: PASSWORD });
    expect(l.body).toEqual({ next: 'totp_verify' });
    expect((await agent.get('/admin/keys')).body.error.code).toBe('MFA_REQUIRED');
    const v = await agent.post('/admin/auth/totp/verify').set(o()).send({ code: await nextCode(s, me.userId) });
    expect(v.status).toBe(200);

    // disable: wrong password refused, right password works
    const h = { Origin: s.baseUrl, 'X-CSRF-Token': v.body.csrfToken };
    const wrong = await agent.post('/admin/account/totp/disable').set(h).send({ password: 'not my password!!' });
    expect(wrong.body.error.code).toBe('INVALID_CREDENTIALS');
    const off = await agent.post('/admin/account/totp/disable').set(h).send({ password: PASSWORD });
    expect(off.body.totpEnrolled).toBe(false);
    expect((await request(s.baseUrl).post('/admin/auth/login').set(o()).send({ email: me.email, password: PASSWORD })).body.next).toBe('done');

    const actions = (await s.prisma.adminAudit.findMany({ where: { actorId: me.userId } })).map((a) => a.action);
    expect(actions).toEqual(expect.arrayContaining(['auth.totp_enrolled', 'auth.totp_disabled']));
  });

  it('account endpoints require CSRF and are not available to the static token', async () => {
    const me = await login(s, 'admin');
    expect((await me.agent.post('/admin/account/totp/setup').set({ Origin: s.baseUrl }).send({})).body.error.code).toBe('CSRF_FAILED');
    const tok = await s.http.post('/admin/account/totp/setup').set('Authorization', `Bearer ${s.cfg.ADMIN_TOKEN}`).send({});
    expect(tok.body.error.code).toBe('FORBIDDEN');
  });

  it('secret is stored encrypted, never in plain text', async () => {
    const me = await login(s, 'admin');
    const setup = await me.agent.post('/admin/account/totp/setup').set(me.h).send({});
    const row = await s.prisma.adminUser.findUniqueOrThrow({ where: { id: me.userId } });
    expect(row.totpSecretEnc).not.toContain(setup.body.secret);
    expect(s.api.get(SecretBox).open(row.totpSecretEnc!)).toBe(setup.body.secret);
    expect(totpStep()).toBeGreaterThan(0);
  });
});

describe('TOTP_REQUIRED=true', () => {
  it('forces enrollment at login and refuses disabling', async () => {
    const req = await startStack({ TOTP_REQUIRED: 'true' }, { worker: false });
    try {
      const me = await login(req, 'admin'); // helper completes the mandatory enrollment
      expect((await req.http.get('/admin/auth/config')).body.totpRequired).toBe(true);
      const r = await me.agent.post('/admin/account/totp/disable').set(me.h).send({ password: PASSWORD });
      expect(r.body.error.code).toBe('INVALID_STATE');
      expect(r.body.error.message).toMatch(/required by the gateway policy/);
    } finally {
      await req.close();
    }
  });
});
