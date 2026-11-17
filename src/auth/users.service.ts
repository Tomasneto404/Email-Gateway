import { Inject, Injectable } from '@nestjs/common';
import { Actor, AdminAuditService } from '../admin/admin-audit.service';
import { APP_CONFIG, AppConfig } from '../config/config';
import { GatewayError } from '../common/errors';
import { PrismaService } from '../common/prisma.service';
import { isPlainEmail } from '../common/validators';
import { AdminUser, Prisma, Role } from '../generated/prisma/client';
import { randomToken, sha256hex } from './crypto';
import { assertPasswordPolicy, hashPassword } from './password';
import { ADMIN_ROLE, covers, effectivePermissions, hasPermission } from './permissions';
import { SessionsService, UserWithRoles } from './sessions.service';
import { SystemMailService } from './system-mail.service';

type Tx = Prisma.TransactionClient;

export interface UserView {
  id: string;
  email: string;
  name: string;
  roles: Array<{ id: string; name: string }>;
  permissions: string[];
  authSource: string;
  totpEnrolled: boolean;
  disabled: boolean;
  locked: boolean;
  pendingInvite: boolean;
  lastLoginAt: string | null;
  createdAt: string;
}

export const WITH_ROLES = { roles: { include: { role: true } } } as const;

export function toUserView(u: UserWithRoles & { invites?: Array<{ usedAt: Date | null; expiresAt: Date }> }): UserView {
  const roles = u.roles.map((r) => r.role).sort((a, b) => a.name.localeCompare(b.name));
  return {
    id: u.id,
    email: u.email,
    name: u.name,
    roles: roles.map((r) => ({ id: r.id, name: r.name })),
    permissions: effectivePermissions(roles),
    authSource: u.authSource,
    totpEnrolled: u.totpEnrolled,
    disabled: u.disabled,
    locked: !!u.lockedUntil && u.lockedUntil.getTime() > Date.now(),
    pendingInvite: !u.passwordHash && u.authSource === 'local' && !!u.invites?.some((i) => !i.usedAt && i.expiresAt.getTime() > Date.now()),
    lastLoginAt: u.lastLoginAt?.toISOString() ?? null,
    createdAt: u.createdAt.toISOString(),
  };
}

/** At least one enabled user must keep "*" (otherwise nobody can administer the gateway). */
export async function assertAdminRemains(tx: Tx | PrismaService) {
  const rows = await tx.$queryRaw<Array<{ n: bigint }>>`
    SELECT COUNT(DISTINCT u.id)::bigint AS n
    FROM admin_users u
    JOIN admin_user_roles ur ON ur.user_id = u.id
    JOIN roles r ON r.id = ur.role_id
    WHERE NOT u.disabled AND '*' = ANY(r.permissions)`;
  if (Number(rows[0]?.n ?? 0) === 0) {
    throw new GatewayError('INVALID_STATE', 'This would leave no active user with full (Admin) access. Grant Admin to someone else first.');
  }
}

@Injectable()
export class UsersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly sessions: SessionsService,
    private readonly audit: AdminAuditService,
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
    private readonly mail: SystemMailService,
  ) {}

  /** Emails the invite link when system mail is configured; the link is always returned too. */
  private async deliverInvite(email: string, token: string, actor: Actor, origin: string | undefined, reset = false) {
    const invitePath = `/ui/invite/${token}`;
    let emailed = false;
    try {
      emailed = await this.mail.sendInvite(email, this.mail.absoluteUrl(invitePath, origin), {
        expiresInHours: this.cfg.INVITE_TTL_HOURS,
        invitedBy: actor.label,
        reset,
      });
    } catch {
      emailed = false; // queue unavailable: fall back to sharing the link manually
    }
    return { invitePath, expiresInHours: this.cfg.INVITE_TTL_HOURS, emailed };
  }

  // ------------------------------------------------------------ helpers

  /** Resolves role ids or names (case-insensitive) to roles; rejects unknown ones. */
  async resolveRoles(refs: unknown, tx: Tx | PrismaService = this.prisma): Promise<Role[]> {
    if (!Array.isArray(refs) || !refs.every((r) => typeof r === 'string')) {
      throw new GatewayError('VALIDATION_FAILED', 'roleIds must be an array of role ids.');
    }
    const uniq = [...new Set(refs as string[])];
    if (!uniq.length) return [];
    const ids = uniq.filter((r) => /^[0-9a-f-]{36}$/i.test(r));
    const names = uniq.filter((r) => !ids.includes(r));
    const roles = await tx.role.findMany({
      where: { OR: [{ id: { in: ids } }, ...names.map((n) => ({ name: { equals: n, mode: 'insensitive' as const } }))] },
    });
    if (roles.length !== uniq.length) throw new GatewayError('VALIDATION_FAILED', 'One or more roles do not exist.');
    return roles;
  }

  /** Anti-escalation: an actor may only grant/revoke/affect permissions it holds itself. */
  assertCovers(actor: Actor, perms: string[], what: string) {
    if (!covers(actor.permissions ?? [], perms)) {
      throw new GatewayError('FORBIDDEN', `You cannot ${what}: it involves permissions you do not have.`);
    }
  }

  private validateEmail(email: unknown): asserts email is string {
    if (!isPlainEmail(email)) throw new GatewayError('VALIDATION_FAILED', 'email must be a valid address.');
  }

  async getFull(id: string): Promise<UserWithRoles> {
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw new GatewayError('NOT_FOUND', 'User not found.');
    const u = await this.prisma.adminUser.findUnique({ where: { id }, include: WITH_ROLES });
    if (!u) throw new GatewayError('NOT_FOUND', 'User not found.');
    return u;
  }

  async get(id: string): Promise<AdminUser> {
    return this.getFull(id);
  }

  async getByEmail(email: string) {
    const u = await this.prisma.adminUser.findUnique({ where: { email: email.trim().toLowerCase() }, include: WITH_ROLES });
    if (!u) throw new GatewayError('NOT_FOUND', `User ${email} not found.`);
    return u;
  }

  private perms(u: UserWithRoles) {
    return effectivePermissions(u.roles.map((r) => r.role));
  }

  // ------------------------------------------------------------ create / invite

  /** CLI bootstrap: local user with a password and roles (by name or id; default Admin). */
  async createLocal(input: { email: string; name?: string; roles?: string[]; password: string }, actor: Actor) {
    const email = input.email.trim().toLowerCase();
    this.validateEmail(email);
    assertPasswordPolicy(input.password);
    const roles = await this.resolveRoles(input.roles?.length ? input.roles : [ADMIN_ROLE]);
    this.assertCovers(actor, effectivePermissions(roles), 'assign these roles');
    if (await this.prisma.adminUser.findUnique({ where: { email } })) throw new GatewayError('CONFLICT', `User ${email} already exists.`);
    const u = await this.prisma.adminUser.create({
      data: {
        email,
        name: input.name ?? '',
        passwordHash: await hashPassword(input.password),
        roles: { create: roles.map((r) => ({ roleId: r.id })) },
      },
      include: WITH_ROLES,
    });
    await this.audit.record(actor, { action: 'user.create', targetType: 'admin_user', targetId: u.id, details: { email, roles: roles.map((r) => r.name) } });
    return toUserView(u);
  }

  /** UI: local user without password + one-time invite link (shown once). */
  async invite(body: Record<string, unknown>, actor: Actor, origin?: string) {
    const email = String(body?.email ?? '').trim().toLowerCase();
    this.validateEmail(email);
    const roles = await this.resolveRoles(body.roleIds ?? []);
    if (!roles.length) throw new GatewayError('VALIDATION_FAILED', 'Assign at least one role.');
    this.assertCovers(actor, effectivePermissions(roles), 'assign these roles');
    if (await this.prisma.adminUser.findUnique({ where: { email } })) throw new GatewayError('CONFLICT', `User ${email} already exists.`);
    const u = await this.prisma.adminUser.create({
      data: {
        email,
        name: typeof body.name === 'string' ? body.name.slice(0, 100) : '',
        roles: { create: roles.map((r) => ({ roleId: r.id })) },
      },
      include: WITH_ROLES,
    });
    const token = await this.issueInvite(u.id);
    const link = await this.deliverInvite(email, token, actor, origin);
    await this.audit.record(actor, {
      action: 'user.invite',
      targetType: 'admin_user',
      targetId: u.id,
      details: { email, roles: roles.map((r) => r.name), emailed: link.emailed },
    });
    return { user: toUserView(u), ...link };
  }

  private async issueInvite(userId: string) {
    const token = randomToken(32);
    await this.prisma.adminInvite.updateMany({ where: { userId, usedAt: null }, data: { usedAt: new Date() } });
    await this.prisma.adminInvite.create({
      data: { tokenHash: sha256hex(token), userId, expiresAt: new Date(Date.now() + this.cfg.INVITE_TTL_HOURS * 3600_000) },
    });
    return token;
  }

  async inviteInfo(token: string) {
    const inv = await this.prisma.adminInvite.findUnique({ where: { tokenHash: sha256hex(token) }, include: { user: true } });
    if (!inv || inv.usedAt || inv.expiresAt.getTime() < Date.now() || inv.user.disabled) {
      throw new GatewayError('INVITE_INVALID', 'This invite link is invalid or has expired. Ask an administrator for a new one.');
    }
    return inv;
  }

  async acceptInvite(token: string, password: unknown, ip?: string) {
    assertPasswordPolicy(password);
    const inv = await this.inviteInfo(token);
    await this.prisma.$transaction([
      this.prisma.adminInvite.update({ where: { tokenHash: inv.tokenHash }, data: { usedAt: new Date() } }),
      this.prisma.adminUser.update({ where: { id: inv.userId }, data: { passwordHash: await hashPassword(password), failedLogins: 0, lockedUntil: null } }),
    ]);
    await this.audit.record({ type: 'user', id: inv.userId, label: inv.user.email, ip }, { action: 'user.invite_accepted', targetType: 'admin_user', targetId: inv.userId });
    return { email: inv.user.email };
  }

  // ------------------------------------------------------------ read

  async list() {
    const users = await this.prisma.adminUser.findMany({
      orderBy: { email: 'asc' },
      include: { ...WITH_ROLES, invites: { select: { usedAt: true, expiresAt: true } } },
    });
    return { items: users.map(toUserView), total: users.length };
  }

  // ------------------------------------------------------------ update

  async update(id: string, body: Record<string, unknown>, actor: Actor) {
    const u = await this.getFull(id);
    const targetPerms = this.perms(u);
    const changes: Record<string, unknown> = {};
    const data: Prisma.AdminUserUpdateInput = {};

    if (body.name !== undefined) {
      if (typeof body.name !== 'string' || body.name.length > 100) throw new GatewayError('VALIDATION_FAILED', 'name must be a string (max 100).');
      data.name = body.name;
      changes.name = body.name;
    }
    if (body.disabled !== undefined) {
      if (typeof body.disabled !== 'boolean') throw new GatewayError('VALIDATION_FAILED', 'disabled must be boolean.');
      if (body.disabled && actor.id === id) throw new GatewayError('INVALID_STATE', 'You cannot disable your own account.');
      this.assertCovers(actor, targetPerms, `${body.disabled ? 'disable' : 'enable'} this user`);
      data.disabled = body.disabled;
      changes.disabled = body.disabled;
    }
    let newRoles: Role[] | undefined;
    if (body.roleIds !== undefined) {
      if (u.authSource !== 'local') throw new GatewayError('INVALID_STATE', 'Roles of SSO users come from their Authentik groups (see Roles › Authentik groups).');
      newRoles = await this.resolveRoles(body.roleIds);
      if (!newRoles.length) throw new GatewayError('VALIDATION_FAILED', 'A user needs at least one role. Disable the user instead.');
      const before = new Set(u.roles.map((r) => r.role.id));
      const after = new Set(newRoles.map((r) => r.id));
      const touched = [...u.roles.map((r) => r.role).filter((r) => !after.has(r.id)), ...newRoles.filter((r) => !before.has(r.id))];
      this.assertCovers(actor, effectivePermissions(touched), 'change these roles');
      changes.roles = { from: u.roles.map((r) => r.role.name).sort(), to: newRoles.map((r) => r.name).sort() };
    }

    const updated = await this.prisma.$transaction(async (tx) => {
      if (newRoles) {
        await tx.adminUserRole.deleteMany({ where: { userId: id } });
        await tx.adminUserRole.createMany({ data: newRoles.map((r) => ({ userId: id, roleId: r.id })) });
      }
      const res = await tx.adminUser.update({ where: { id }, data, include: WITH_ROLES });
      if (newRoles || changes.disabled === true) await assertAdminRemains(tx);
      return res;
    });
    // permissions are re-evaluated on every request, so role changes apply immediately; disabling ends sessions
    if (changes.disabled === true) await this.sessions.destroyAllForUser(id);
    const action = changes.disabled === true ? 'user.disable' : changes.disabled === false ? 'user.enable' : newRoles ? 'user.roles_update' : 'user.update';
    await this.audit.record(actor, { action, targetType: 'admin_user', targetId: id, details: { email: u.email, changes } });
    return toUserView(updated);
  }

  async resetTotp(id: string, actor: Actor) {
    const u = await this.getFull(id);
    if (u.authSource !== 'local') throw new GatewayError('INVALID_STATE', 'SSO users use Authentik MFA.');
    this.assertCovers(actor, this.perms(u), "reset this user's 2FA");
    const updated = await this.prisma.adminUser.update({
      where: { id },
      data: { totpSecretEnc: null, totpEnrolled: false, totpLastStep: null },
      include: WITH_ROLES,
    });
    await this.sessions.destroyAllForUser(id);
    await this.audit.record(actor, { action: 'user.reset_2fa', targetType: 'admin_user', targetId: id, details: { email: u.email } });
    return toUserView(updated);
  }

  /** Clears the password + TOTP, kills sessions and returns a fresh invite link. */
  async resetAccess(id: string, actor: Actor, origin?: string) {
    const u = await this.getFull(id);
    if (u.authSource !== 'local') throw new GatewayError('INVALID_STATE', 'SSO users authenticate with Authentik; reset access there.');
    this.assertCovers(actor, this.perms(u), "reset this user's access");
    await this.prisma.adminUser.update({
      where: { id },
      data: { passwordHash: null, totpSecretEnc: null, totpEnrolled: false, totpLastStep: null, failedLogins: 0, lockedUntil: null },
    });
    await this.sessions.destroyAllForUser(id);
    const token = await this.issueInvite(id);
    const link = await this.deliverInvite(u.email, token, actor, origin, true);
    await this.audit.record(actor, { action: 'user.reset_access', targetType: 'admin_user', targetId: id, details: { email: u.email, emailed: link.emailed } });
    return link;
  }

  async remove(id: string, actor: Actor) {
    const u = await this.getFull(id);
    if (actor.id === id) throw new GatewayError('INVALID_STATE', 'You cannot delete your own account.');
    this.assertCovers(actor, this.perms(u), 'delete this user');
    await this.prisma.$transaction(async (tx) => {
      await tx.adminUser.delete({ where: { id } });
      if (hasPermission(this.perms(u), '*')) await assertAdminRemains(tx);
    });
    await this.audit.record(actor, { action: 'user.delete', targetType: 'admin_user', targetId: id, details: { email: u.email } });
  }
}
