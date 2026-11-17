import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LoggedIn, login } from '../helpers/admin-login';
import { Stack, createKey, resetState, startStack, uname, waitFor } from '../helpers/stack';

let s: Stack;
let admin: LoggedIn;
const roleId = async (name: string) => (await s.prisma.role.findUniqueOrThrow({ where: { name } })).id;

beforeAll(async () => {
  s = await startStack();
  await resetState(s);
  admin = await login(s, 'admin');
});
afterAll(async () => s?.close());

describe('built-in roles', () => {
  it('are seeded and listed with the permission catalog', async () => {
    const roles = await admin.agent.get('/admin/roles');
    expect(roles.body.items.map((r: { name: string }) => r.name)).toEqual(
      expect.arrayContaining(['Admin', 'Operator', 'Approver', 'Auditor', 'Viewer', 'Body reader']),
    );
    const adminRole = roles.body.items.find((r: { name: string }) => r.name === 'Admin');
    expect(adminRole).toMatchObject({ permissions: ['*'], builtin: true, editable: false, ssoGroups: ['mail-gateway-admins'] });
    const cat = await admin.agent.get('/admin/roles/permissions');
    expect(cat.body.map((p: { id: string }) => p.id)).toEqual(expect.arrayContaining(['keys:promote', 'messages:bodies', 'roles:manage']));
  });

  it('Operator manages keys and the gateway, but cannot promote to live, approve, read bodies or see users', async () => {
    const op = await login(s, ['Operator']);
    const created = await op.agent.post('/admin/keys').set(op.h).send({ name: uname('op'), fromAddress: 'bot@gateway.test', allowedRecipients: ['@example.com'] });
    expect(created.status).toBe(201);
    const id = created.body.key.id;
    expect((await op.agent.patch(`/admin/keys/${id}`).set(op.h).send({ quotaPerHour: 7 })).body.quotaPerHour).toBe(7);
    expect((await op.agent.post(`/admin/keys/${id}/rotate`).set(op.h).send({})).status).toBe(200);

    // cannot bypass keys:promote by creating a non-sandbox key directly
    for (const mode of ['live', 'approval']) {
      const direct = await op.agent.post('/admin/keys').set(op.h).send({ name: uname('op-direct'), fromAddress: 'bot@gateway.test', mode });
      expect({ mode, status: direct.status, code: direct.body.error?.code }).toEqual({ mode, status: 403, code: 'FORBIDDEN' });
    }

    const promote = await op.agent.patch(`/admin/keys/${id}`).set(op.h).send({ mode: 'live' });
    expect(promote.status).toBe(403);
    expect(promote.body.error.message).toContain('keys:promote');
    expect((await op.agent.get('/admin/users')).status).toBe(403);
    expect((await op.agent.post('/admin/messages/approve').set(op.h).send({ ids: [] })).status).toBe(403);
    expect((await op.agent.delete(`/admin/keys/${id}`).set(op.h)).status).toBe(403); // keys:delete not granted

    const p = await op.agent.post('/admin/gateway/pause').set(op.h).send({ reason: 'op test' });
    expect(p.body.paused).toBe(true);
    await op.agent.post('/admin/gateway/resume').set(op.h).send({});

    const { secret } = await createKey(s, { name: uname('opbody') });
    const sent = await s.http.post('/v1/send').set('Authorization', `Bearer ${secret}`).send({ to: 'a@example.com', subject: 'x', text: 'secret body' });
    const d = await op.agent.get(`/admin/messages/${sent.body.id}`);
    expect(d.body).toMatchObject({ bodiesVisible: false, textBody: null });
    expect((await op.agent.get(`/admin/messages/${sent.body.id}/preview`)).status).toBe(403);
  });

  it('Approver approves messages and sees bodies, but cannot create keys', async () => {
    const ap = await login(s, ['Approver']);
    const { secret } = await createKey(s, { name: uname('appr'), mode: 'approval' });
    const sent = await s.http.post('/v1/send').set('Authorization', `Bearer ${secret}`).send({ to: 'a@example.com', subject: 'needs ok', text: 'body' });
    expect((await ap.agent.get(`/admin/messages/${sent.body.id}`)).body.textBody).toBe('body');
    expect((await ap.agent.post(`/admin/messages/${sent.body.id}/approve`).set(ap.h).send({})).body.status).toBe('queued');
    expect((await ap.agent.post('/admin/keys').set(ap.h).send({ name: uname('no'), fromAddress: 'a@example.com' })).status).toBe(403);
  });

  it('multiple roles = union of permissions (Viewer + Body reader)', async () => {
    const v = await login(s, ['Viewer', 'Body reader']);
    const me = await v.agent.get('/admin/auth/session');
    expect(me.body.user.permissions).toEqual(expect.arrayContaining(['keys:read', 'messages:read', 'messages:bodies']));
    expect(me.body.user.roles.map((r: { name: string }) => r.name)).toEqual(['Body reader', 'Viewer']);
  });

  it('built-in roles cannot be deleted; Admin cannot be edited', async () => {
    expect((await admin.agent.delete(`/admin/roles/${await roleId('Viewer')}`).set(admin.h)).body.error.code).toBe('INVALID_STATE');
    expect((await admin.agent.patch(`/admin/roles/${await roleId('Admin')}`).set(admin.h).send({ permissions: ['keys:read'] })).body.error.code).toBe('INVALID_STATE');
    expect((await admin.agent.patch(`/admin/roles/${await roleId('Viewer')}`).set(admin.h).send({ name: 'Renamed' })).body.error.code).toBe('INVALID_STATE');
  });
});

describe('custom roles', () => {
  it('create → assign → changes apply immediately → delete (audited)', async () => {
    const created = await admin.agent
      .post('/admin/roles')
      .set(admin.h)
      .send({ name: uname('Rotator'), description: 'rotates keys', permissions: ['keys:read', 'keys:rotate'], ssoGroups: ['ops-rotators'] });
    expect(created.status).toBe(201);
    const rid = created.body.id;
    const bad = await admin.agent.post('/admin/roles').set(admin.h).send({ name: uname('Bad'), permissions: ['keys:nuke'] });
    expect(bad.body.error.code).toBe('VALIDATION_FAILED');

    const u = await login(s, [created.body.name]);
    const { key } = await createKey(s, { name: uname('rot') });
    expect((await u.agent.post(`/admin/keys/${key.id}/rotate`).set(u.h).send({})).status).toBe(200);
    expect((await u.agent.patch(`/admin/keys/${key.id}`).set(u.h).send({ quotaPerHour: 1 })).status).toBe(403);

    // grant keys:update to the role → effective on the very next request (no re-login)
    await admin.agent.patch(`/admin/roles/${rid}`).set(admin.h).send({ permissions: ['keys:read', 'keys:rotate', 'keys:update'] });
    expect((await u.agent.patch(`/admin/keys/${key.id}`).set(u.h).send({ quotaPerHour: 1 })).status).toBe(200);

    expect((await admin.agent.delete(`/admin/roles/${rid}`).set(admin.h)).status).toBe(204);
    expect((await u.agent.get('/admin/keys')).status).toBe(403); // lost its only role

    const actions = (await s.prisma.adminAudit.findMany({ where: { targetId: rid } })).map((a) => a.action);
    expect(actions).toEqual(expect.arrayContaining(['role.create', 'role.update', 'role.delete']));
  });

  it('assigning roles to a user is audited and applies immediately', async () => {
    const v = await login(s, ['Viewer']);
    expect((await v.agent.post('/admin/keys').set(v.h).send({ name: uname('x'), fromAddress: 'a@example.com' })).status).toBe(403);
    const r = await admin.agent.patch(`/admin/users/${v.userId}`).set(admin.h).send({ roleIds: [await roleId('Viewer'), await roleId('Operator')] });
    expect(r.body.roles.map((x: { name: string }) => x.name)).toEqual(['Operator', 'Viewer']);
    expect((await v.agent.post('/admin/keys').set(v.h).send({ name: uname('y'), fromAddress: 'a@example.com', allowedRecipients: ['@example.com'] })).status).toBe(201);
    const audit = await s.prisma.adminAudit.findFirst({ where: { action: 'user.roles_update', targetId: v.userId } });
    expect(audit?.details).toMatchObject({ changes: { roles: { from: ['Viewer'], to: ['Operator', 'Viewer'] } } });
  });
});

describe('anti-escalation', () => {
  let mgr: LoggedIn;
  beforeAll(async () => {
    // a user manager without access to message bodies
    const role = await admin.agent
      .post('/admin/roles')
      .set(admin.h)
      .send({ name: uname('UserMgr'), permissions: ['users:read', 'users:manage', 'roles:manage', 'keys:read'] });
    mgr = await login(s, [role.body.name]);
  });

  it('cannot grant roles with permissions it does not hold', async () => {
    const v = await login(s, ['Viewer']);
    const toBody = await mgr.agent.patch(`/admin/users/${v.userId}`).set(mgr.h).send({ roleIds: ['Viewer', 'Body reader'] });
    expect(toBody.status).toBe(403);
    const toAdmin = await mgr.agent.patch(`/admin/users/${v.userId}`).set(mgr.h).send({ roleIds: ['Admin'] });
    expect(toAdmin.status).toBe(403);
    const invite = await mgr.agent.post('/admin/users').set(mgr.h).send({ email: `${uname('esc')}@admins.test`, roleIds: ['Admin'] });
    expect(invite.status).toBe(403);
  });

  it('cannot create or widen a role beyond its own permissions', async () => {
    expect((await mgr.agent.post('/admin/roles').set(mgr.h).send({ name: uname('God'), permissions: ['*'] })).status).toBe(403);
    expect((await mgr.agent.post('/admin/roles').set(mgr.h).send({ name: uname('Peek'), permissions: ['messages:bodies'] })).status).toBe(403);
    expect((await mgr.agent.patch(`/admin/roles/${await roleId('Operator')}`).set(mgr.h).send({ description: 'x' })).status).toBe(403);
    const ok = await mgr.agent.post('/admin/roles').set(mgr.h).send({ name: uname('KeyReader'), permissions: ['keys:read'] });
    expect(ok.status).toBe(201);
  });

  it('cannot disable, reset or delete a more privileged user', async () => {
    const other = await login(s, 'admin');
    expect((await mgr.agent.patch(`/admin/users/${other.userId}`).set(mgr.h).send({ disabled: true })).status).toBe(403);
    expect((await mgr.agent.post(`/admin/users/${other.userId}/reset-2fa`).set(mgr.h).send({})).status).toBe(403);
    expect((await mgr.agent.delete(`/admin/users/${other.userId}`).set(mgr.h)).status).toBe(403);
  });
});

describe('at least one active Admin always remains', () => {
  it('refuses to remove the last Admin', async () => {
    const others = await s.prisma.$queryRaw<Array<{ id: string }>>`
      SELECT DISTINCT u.id FROM admin_users u JOIN admin_user_roles ur ON ur.user_id = u.id JOIN roles r ON r.id = ur.role_id
      WHERE '*' = ANY(r.permissions) AND NOT u.disabled AND u.id <> ${admin.userId}::uuid`;
    const ids = others.map((o) => o.id);
    await s.prisma.adminUser.updateMany({ where: { id: { in: ids } }, data: { disabled: true } });
    try {
      const r = await admin.agent.patch(`/admin/users/${admin.userId}`).set(admin.h).send({ roleIds: ['Viewer'] });
      expect(r.body.error.code).toBe('INVALID_STATE');
      expect(r.body.error.message).toMatch(/no active user with full/);
      // still admin
      await waitFor(async () => (await admin.agent.get('/admin/users')).status === 200);
    } finally {
      await s.prisma.adminUser.updateMany({ where: { id: { in: ids } }, data: { disabled: false } });
    }
  });
});
