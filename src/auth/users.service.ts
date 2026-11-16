import { Inject, Injectable } from '@nestjs/common';
import { Actor, AdminAuditService } from '../admin/admin-audit.service';
import { APP_CONFIG, AppConfig } from '../config/config';
import { GatewayError } from '../common/errors';
import { PrismaService } from '../common/prisma.service';
import { isPlainEmail } from '../common/validators';
import { AdminRole, AdminUser, Prisma } from '../generated/prisma/client';
import { randomToken, sha256hex } from './crypto';
import { assertPasswordPolicy, hashPassword } from './password';
import { SessionsService } from './sessions.service';

export interface UserView {
  id: string;
  email: string;
  name: string;
  role: AdminRole;
  canViewBodies: boolean;
  authSource: string;
  totpEnrolled: boolean;
  disabled: boolean;
  locked: boolean;
  pendingInvite: boolean;
  lastLoginAt: string | null;
  createdAt: string;
}

export function toUserView(u: AdminUser & { invites?: Array<{ usedAt: Date | null; expiresAt: Date }> }): UserView {
  return {
    id: u.id,
    email: u.email,
    name: u.name,
    role: u.role,
    canViewBodies: u.role === 'admin' || u.canViewBodies,
    authSource: u.authSource,
    totpEnrolled: u.totpEnrolled,
    disabled: u.disabled,
    locked: !!u.lockedUntil && u.lockedUntil.getTime() > Date.now(),
    pendingInvite: !u.passwordHash && u.authSource === 'local' && !!u.invites?.some((i) => !i.usedAt && i.expiresAt.getTime() > Date.now()),
    lastLoginAt: u.lastLoginAt?.toISOString() ?? null,
    createdAt: u.createdAt.toISOString(),
  };
}

const ROLES: AdminRole[] = ['admin', 'viewer'];

@Injectable()
export class UsersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly sessions: SessionsService,
    private readonly audit: AdminAuditService,
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
  ) {}

  private validateIdentity(email: unknown, role: unknown) {
    if (!isPlainEmail(email)) throw new GatewayError('VALIDATION_FAILED', 'email must be a valid address.');
    if (!ROLES.includes(role as AdminRole)) throw new GatewayError('VALIDATION_FAILED', 'role must be "admin" or "viewer".');
  }

  /** CLI bootstrap: local user with a password. TOTP is enrolled at first login. */
  async createLocal(input: { email: string; name?: string; role: AdminRole; canViewBodies?: boolean; password: string }, actor: Actor) {
    const email = input.email.trim().toLowerCase();
    this.validateIdentity(email, input.role);
    assertPasswordPolicy(input.password);
    if (await this.prisma.adminUser.findUnique({ where: { email } })) throw new GatewayError('CONFLICT', `User ${email} already exists.`);
    const u = await this.prisma.adminUser.create({
      data: { email, name: input.name ?? '', role: input.role, canViewBodies: !!input.canViewBodies, passwordHash: await hashPassword(input.password) },
    });
    await this.audit.record(actor, { action: 'user.create', targetType: 'admin_user', targetId: u.id, details: { email, role: u.role } });
    return toUserView(u);
  }

  /** UI: create a local user without a password and return a one-time invite link token. */
  async invite(body: Record<string, unknown>, actor: Actor) {
    const email = String(body?.email ?? '').trim().toLowerCase();
    const role = (body?.role ?? 'viewer') as AdminRole;
    this.validateIdentity(email, role);
    if (await this.prisma.adminUser.findUnique({ where: { email } })) throw new GatewayError('CONFLICT', `User ${email} already exists.`);
    const u = await this.prisma.adminUser.create({
      data: { email, name: typeof body.name === 'string' ? body.name.slice(0, 100) : '', role, canViewBodies: body.canViewBodies === true },
    });
    const token = await this.issueInvite(u.id);
    await this.audit.record(actor, { action: 'user.invite', targetType: 'admin_user', targetId: u.id, details: { email, role } });
    return { user: toUserView(u), invitePath: `/ui/invite/${token}`, expiresInHours: this.cfg.INVITE_TTL_HOURS };
  }

  private async issueInvite(userId: string) {
    const token = randomToken(32);
    await this.prisma.adminInvite.updateMany({ where: { userId, usedAt: null }, data: { usedAt: new Date() } });
    await this.prisma.adminInvite.create({
      data: { tokenHash: sha256hex(token), userId, expiresAt: new Date(Date.now() + this.cfg.INVITE_TTL_HOURS * 3600_000) },
    });
    return token;
  }

  /** Clears the password + TOTP, kills sessions and returns a fresh invite link (admin "reset access"). */
  async resetAccess(id: string, actor: Actor) {
    const u = await this.get(id);
    if (u.authSource !== 'local') throw new GatewayError('INVALID_STATE', 'SSO users authenticate with Authentik; reset access there.');
    await this.prisma.adminUser.update({
      where: { id },
      data: { passwordHash: null, totpSecretEnc: null, totpEnrolled: false, totpLastStep: null, failedLogins: 0, lockedUntil: null },
    });
    await this.sessions.destroyAllForUser(id);
    const token = await this.issueInvite(id);
    await this.audit.record(actor, { action: 'user.reset_access', targetType: 'admin_user', targetId: id, details: { email: u.email } });
    return { invitePath: `/ui/invite/${token}`, expiresInHours: this.cfg.INVITE_TTL_HOURS };
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

  async list() {
    const users = await this.prisma.adminUser.findMany({ orderBy: { email: 'asc' }, include: { invites: { select: { usedAt: true, expiresAt: true } } } });
    return { items: users.map(toUserView), total: users.length };
  }

  async get(id: string) {
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw new GatewayError('NOT_FOUND', 'User not found.');
    const u = await this.prisma.adminUser.findUnique({ where: { id } });
    if (!u) throw new GatewayError('NOT_FOUND', 'User not found.');
    return u;
  }

  async getByEmail(email: string) {
    const u = await this.prisma.adminUser.findUnique({ where: { email: email.trim().toLowerCase() } });
    if (!u) throw new GatewayError('NOT_FOUND', `User ${email} not found.`);
    return u;
  }

  async update(id: string, body: Record<string, unknown>, actor: Actor) {
    const u = await this.get(id);
    const data: Prisma.AdminUserUpdateInput = {};
    const changes: Record<string, unknown> = {};
    if (body.role !== undefined) {
      if (!ROLES.includes(body.role as AdminRole)) throw new GatewayError('VALIDATION_FAILED', 'role must be "admin" or "viewer".');
      if (u.authSource !== 'local') throw new GatewayError('INVALID_STATE', 'Roles of SSO users are managed by Authentik groups.');
      data.role = body.role as AdminRole;
      changes.role = body.role;
    }
    if (body.canViewBodies !== undefined) {
      if (typeof body.canViewBodies !== 'boolean') throw new GatewayError('VALIDATION_FAILED', 'canViewBodies must be boolean.');
      if (u.authSource !== 'local') throw new GatewayError('INVALID_STATE', 'Body access of SSO users is managed by Authentik groups.');
      data.canViewBodies = body.canViewBodies;
      changes.canViewBodies = body.canViewBodies;
    }
    if (body.disabled !== undefined) {
      if (typeof body.disabled !== 'boolean') throw new GatewayError('VALIDATION_FAILED', 'disabled must be boolean.');
      if (body.disabled && actor.id === id) throw new GatewayError('INVALID_STATE', 'You cannot disable your own account.');
      data.disabled = body.disabled;
      changes.disabled = body.disabled;
    }
    if (body.name !== undefined) {
      if (typeof body.name !== 'string' || body.name.length > 100) throw new GatewayError('VALIDATION_FAILED', 'name must be a string (max 100).');
      data.name = body.name;
      changes.name = body.name;
    }
    const demotes = (changes.role === 'viewer' && u.role === 'admin') || (changes.disabled === true && u.role === 'admin');
    if (demotes) await this.assertNotLastAdmin(id);
    const updated = await this.prisma.adminUser.update({ where: { id }, data });
    if (changes.disabled === true || changes.role) await this.sessions.destroyAllForUser(id);
    await this.audit.record(actor, { action: changes.disabled === true ? 'user.disable' : changes.disabled === false ? 'user.enable' : 'user.update', targetType: 'admin_user', targetId: id, details: { email: u.email, changes } });
    return toUserView(updated);
  }

  async resetTotp(id: string, actor: Actor) {
    const u = await this.get(id);
    if (u.authSource !== 'local') throw new GatewayError('INVALID_STATE', 'SSO users use Authentik MFA.');
    const updated = await this.prisma.adminUser.update({ where: { id }, data: { totpSecretEnc: null, totpEnrolled: false, totpLastStep: null } });
    await this.sessions.destroyAllForUser(id);
    await this.audit.record(actor, { action: 'user.reset_2fa', targetType: 'admin_user', targetId: id, details: { email: u.email } });
    return toUserView(updated);
  }

  async remove(id: string, actor: Actor) {
    const u = await this.get(id);
    if (actor.id === id) throw new GatewayError('INVALID_STATE', 'You cannot delete your own account.');
    if (u.role === 'admin') await this.assertNotLastAdmin(id);
    await this.prisma.adminUser.delete({ where: { id } });
    await this.audit.record(actor, { action: 'user.delete', targetType: 'admin_user', targetId: id, details: { email: u.email } });
  }

  private async assertNotLastAdmin(id: string) {
    const others = await this.prisma.adminUser.count({ where: { role: 'admin', disabled: false, id: { not: id } } });
    if (others === 0) throw new GatewayError('INVALID_STATE', 'This is the last active admin; create another admin first.');
  }
}
