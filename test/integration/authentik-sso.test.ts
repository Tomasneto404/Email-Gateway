// Authored by Tomás Neto (TN 2026)
import { OAuth2Server } from 'oauth2-mock-server';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Stack, resetState, startStack, uname } from '../helpers/stack';

/** Authentik-shaped issuer: /application/o/<slug>/ path + a `groups` claim in the ID token. */
let idp: OAuth2Server;
let s: Stack;
let claims: Record<string, unknown> = {};

beforeAll(async () => {
  idp = new OAuth2Server();
  await idp.issuer.keys.generate('RS256');
  await idp.start(0, '127.0.0.1');
  idp.service.on('beforeTokenSigning', (token) => {
    Object.assign(token.payload, claims);
  });
  s = await startStack(
    {
      AUTHENTIK_ENABLED: 'true',
      AUTHENTIK_ISSUER: idp.issuer.url!,
      AUTHENTIK_CLIENT_ID: 'mail-gateway',
      AUTHENTIK_CLIENT_SECRET: 'secret',
      AUTHENTIK_ALLOW_INSECURE: 'true',
      PUBLIC_URL: 'http://127.0.0.1:1', // replaced below once the port is known
    },
    { worker: false },
  );
  // PUBLIC_URL must point at the real listener for redirect_uri; patch the live config object.
  (s.cfg as { PUBLIC_URL?: string }).PUBLIC_URL = s.baseUrl;
  await resetState(s);
});
afterAll(async () => {
  await s?.close();
  await idp?.stop();
});

/** Drives the browser redirect chain: gateway → IdP /authorize → gateway callback. */
async function ssoLogin(sub: string, email: string, groups: string[]) {
  claims = { sub, email, name: 'SSO User', groups };
  const agent = request.agent(s.baseUrl);
  const start = await agent.get('/admin/auth/authentik/login');
  expect(start.status).toBe(302);
  const authorize = new URL(start.headers.location);
  expect(authorize.searchParams.get('code_challenge_method')).toBe('S256');
  expect(authorize.searchParams.get('nonce')).toBeTruthy();
  const idpRes = await fetch(authorize, { redirect: 'manual' });
  const callback = new URL(idpRes.headers.get('location')!);
  const cb = await agent.get(callback.pathname + callback.search);
  return { agent, cb };
}

describe('Authentik SSO', () => {
  it('advertises SSO on the login page config', async () => {
    expect((await s.http.get('/admin/auth/config')).body).toEqual({ localLogin: true, authentik: true, totpRequired: false });
  });

  it('admin group → admin session (no local TOTP), audited', async () => {
    const email = `${uname('sso')}@corp.test`;
    const { agent, cb } = await ssoLogin(`sub-${email}`, email, ['mail-gateway-admins']);
    expect(cb.status).toBe(200);
    const sess = await agent.get('/admin/auth/session');
    expect(sess.body.user).toMatchObject({ email, roles: [{ name: 'Admin' }], permissions: ['*'], authSource: 'authentik' });
    expect((await agent.get('/admin/users')).status).toBe(200);
    expect(await s.prisma.adminAudit.count({ where: { actorLabel: email, action: 'auth.login', outcome: 'success' } })).toBe(1);
  });

  it('groups → roles (union); re-synced on every login; roles not editable locally', async () => {
    const email = `${uname('ssov')}@corp.test`;
    const sub = `sub-${email}`;
    const first = await ssoLogin(sub, email, ['mail-gateway-viewers']);
    const u1 = (await first.agent.get('/admin/auth/session')).body.user;
    expect(u1.roles.map((r: { name: string }) => r.name)).toEqual(['Viewer']);
    expect(u1.permissions).not.toContain('messages:bodies');
    expect((await first.agent.get('/admin/users')).status).toBe(403);

    const second = await ssoLogin(sub, email, ['mail-gateway-viewers', 'mail-gateway-body-viewers']);
    const u2 = (await second.agent.get('/admin/auth/session')).body.user;
    expect(u2.roles.map((r: { name: string }) => r.name)).toEqual(['Body reader', 'Viewer']);
    expect(u2.permissions).toContain('messages:bodies');
    const third = await ssoLogin(sub, email, ['mail-gateway-admins']);
    expect((await third.agent.get('/admin/auth/session')).body.user.permissions).toEqual(['*']);
    expect(await s.prisma.adminUser.count({ where: { oidcSubject: sub } })).toBe(1);
    expect(await s.prisma.adminAudit.count({ where: { action: 'user.role_synced', actorLabel: email } })).toBe(2);

    const csrf = (await third.agent.get('/admin/auth/session')).body.csrfToken;
    const user = await s.prisma.adminUser.findUniqueOrThrow({ where: { oidcSubject: sub } });
    const edit = await third.agent.patch(`/admin/users/${user.id}`).set({ Origin: s.baseUrl, 'X-CSRF-Token': csrf }).send({ roleIds: ['Viewer'] });
    expect(edit.body.error.code).toBe('INVALID_STATE');
    expect(edit.body.error.message).toMatch(/Authentik groups/);
  });

  it('no mapped group → access denied, nothing provisioned', async () => {
    const email = `${uname('ssox')}@corp.test`;
    const { agent, cb } = await ssoLogin(`sub-${email}`, email, ['some-other-group']);
    expect(cb.status).toBe(302);
    expect(cb.headers.location).toMatch(/^\/ui\/login\?error=/);
    expect((await agent.get('/admin/auth/session')).status).toBe(401);
    expect(await s.prisma.adminUser.count({ where: { email } })).toBe(0);
  });

  it('callback with a forged/mismatched state is rejected (login CSRF)', async () => {
    claims = { sub: 'x', email: 'x@corp.test', groups: ['mail-gateway-admins'] };
    const victim = request.agent(s.baseUrl);
    const attacker = request.agent(s.baseUrl);
    const start = await attacker.get('/admin/auth/authentik/login');
    const idpRes = await fetch(new URL(start.headers.location), { redirect: 'manual' });
    const callback = new URL(idpRes.headers.get('location')!);
    // the victim's browser has no matching state cookie
    const cb = await victim.get(callback.pathname + callback.search);
    expect(cb.status).toBe(302);
    expect(decodeURIComponent(cb.headers.location)).toContain('Invalid SSO state');
  });

  it('logout returns the Authentik end-session URL', async () => {
    const email = `${uname('sso-out')}@corp.test`;
    const { agent } = await ssoLogin(`sub-${email}`, email, ['mail-gateway-admins']);
    const out = await agent.post('/admin/auth/logout').set({ Origin: s.baseUrl }).send({});
    expect(out.body.redirect).toContain('id_token_hint=');
    expect((await agent.get('/admin/auth/session')).status).toBe(401);
  });

  it('never links SSO to an existing local account with the same email', async () => {
    const { UsersService } = await import('../../src/auth/users.service');
    const { CLI_ACTOR } = await import('../../src/admin/admin-audit.service');
    const email = `${uname('dup')}@corp.test`;
    await s.api.get(UsersService).createLocal({ email, roles: ['Viewer'], password: 'correct horse battery staple' }, CLI_ACTOR);
    const { cb } = await ssoLogin(`sub-${email}`, email, ['mail-gateway-admins']);
    expect(cb.status).toBe(302);
    expect(decodeURIComponent(cb.headers.location)).toContain('local account');
  });
});
