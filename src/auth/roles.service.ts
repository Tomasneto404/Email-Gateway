import { Injectable } from '@nestjs/common';
import { Actor, AdminAuditService } from '../admin/admin-audit.service';
import { GatewayError } from '../common/errors';
import { PrismaService } from '../common/prisma.service';
import { Role } from '../generated/prisma/client';
import { ADMIN_ROLE, PERMISSIONS, covers, isValidPermission } from './permissions';
import { SessionsService } from './sessions.service';
import { assertAdminRemains } from './users.service';

export interface RoleView {
  id: string;
  name: string;
  description: string;
  permissions: string[];
  ssoGroups: string[];
  builtin: boolean;
  editable: boolean;
  userCount: number;
  createdAt: string;
  updatedAt: string;
}

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9 ._-]{1,48}$/;
const GROUP_RE = /^[^\r\n]{1,128}$/;

function toView(r: Role & { _count: { users: number } }): RoleView {
  return {
    id: r.id,
    name: r.name,
    description: r.description,
    permissions: [...r.permissions].sort(),
    ssoGroups: r.ssoGroups,
    builtin: r.builtin,
    editable: r.name !== ADMIN_ROLE,
    userCount: r._count.users,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}

@Injectable()
export class RolesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly sessions: SessionsService,
    private readonly audit: AdminAuditService,
  ) {}

  catalog() {
    return PERMISSIONS.map((p) => ({ id: p.id, area: p.area, label: p.label }));
  }

  async list() {
    const roles = await this.prisma.role.findMany({ orderBy: [{ builtin: 'desc' }, { name: 'asc' }], include: { _count: { select: { users: true } } } });
    return { items: roles.map(toView), total: roles.length };
  }

  private async getRole(id: string) {
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw new GatewayError('NOT_FOUND', 'Role not found.');
    const r = await this.prisma.role.findUnique({ where: { id }, include: { _count: { select: { users: true } } } });
    if (!r) throw new GatewayError('NOT_FOUND', 'Role not found.');
    return r;
  }

  private parse(body: Record<string, unknown>, partial: boolean) {
    const out: { name?: string; description?: string; permissions?: string[]; ssoGroups?: string[] } = {};
    if (body.name !== undefined || !partial) {
      if (typeof body.name !== 'string' || !NAME_RE.test(body.name.trim())) {
        throw new GatewayError('VALIDATION_FAILED', 'name must be 2-49 characters (letters, digits, space, ".", "_", "-").');
      }
      out.name = body.name.trim();
    }
    if (body.description !== undefined) {
      if (typeof body.description !== 'string' || body.description.length > 300) throw new GatewayError('VALIDATION_FAILED', 'description must be a string (max 300).');
      out.description = body.description;
    }
    if (body.permissions !== undefined || !partial) {
      const p = body.permissions;
      if (!Array.isArray(p) || !p.every((x) => typeof x === 'string')) throw new GatewayError('VALIDATION_FAILED', 'permissions must be an array of permission ids.');
      const bad = p.filter((x) => !isValidPermission(x));
      if (bad.length) throw new GatewayError('VALIDATION_FAILED', `Unknown permissions: ${bad.join(', ')}.`, { unknown: bad });
      out.permissions = [...new Set(p as string[])].sort();
    }
    if (body.ssoGroups !== undefined) {
      const g = body.ssoGroups;
      if (!Array.isArray(g) || !g.every((x) => typeof x === 'string' && GROUP_RE.test(x.trim()))) {
        throw new GatewayError('VALIDATION_FAILED', 'ssoGroups must be an array of Authentik group names.');
      }
      out.ssoGroups = [...new Set((g as string[]).map((x) => x.trim()))];
    }
    return out;
  }

  private assertCovers(actor: Actor, perms: string[]) {
    if (!covers(actor.permissions ?? [], perms)) {
      throw new GatewayError('FORBIDDEN', 'You cannot create or edit a role with permissions you do not have.');
    }
  }

  async create(body: Record<string, unknown>, actor: Actor) {
    const d = this.parse(body ?? {}, false);
    this.assertCovers(actor, d.permissions!);
    if (await this.prisma.role.findFirst({ where: { name: { equals: d.name!, mode: 'insensitive' } } })) {
      throw new GatewayError('CONFLICT', `A role named "${d.name}" already exists.`);
    }
    const r = await this.prisma.role.create({
      data: { name: d.name!, description: d.description ?? '', permissions: d.permissions!, ssoGroups: d.ssoGroups ?? [] },
      include: { _count: { select: { users: true } } },
    });
    await this.audit.record(actor, { action: 'role.create', targetType: 'role', targetId: r.id, details: { name: r.name, permissions: r.permissions, ssoGroups: r.ssoGroups } });
    return toView(r);
  }

  async update(id: string, body: Record<string, unknown>, actor: Actor) {
    const before = await this.getRole(id);
    if (before.name === ADMIN_ROLE) throw new GatewayError('INVALID_STATE', 'The built-in Admin role cannot be modified.');
    const d = this.parse(body ?? {}, true);
    if (before.builtin && d.name !== undefined && d.name !== before.name) throw new GatewayError('INVALID_STATE', 'Built-in roles cannot be renamed.');
    // must hold both what the role grants today and what it will grant
    this.assertCovers(actor, [...before.permissions, ...(d.permissions ?? [])]);
    if (d.name && d.name.toLowerCase() !== before.name.toLowerCase()) {
      if (await this.prisma.role.findFirst({ where: { name: { equals: d.name, mode: 'insensitive' } } })) throw new GatewayError('CONFLICT', `A role named "${d.name}" already exists.`);
    }
    const r = await this.prisma.$transaction(async (tx) => {
      const res = await tx.role.update({ where: { id }, data: d, include: { _count: { select: { users: true } } } });
      if (before.permissions.includes('*') && !res.permissions.includes('*')) await assertAdminRemains(tx);
      return res;
    });
    const changes: Record<string, unknown> = {};
    for (const k of ['name', 'description', 'permissions', 'ssoGroups'] as const) {
      if (d[k] !== undefined && JSON.stringify(d[k]) !== JSON.stringify(before[k])) changes[k] = { from: before[k], to: d[k] };
    }
    await this.audit.record(actor, { action: 'role.update', targetType: 'role', targetId: id, details: { name: r.name, changes } });
    return toView(r);
  }

  async remove(id: string, actor: Actor) {
    const r = await this.getRole(id);
    if (r.builtin) throw new GatewayError('INVALID_STATE', 'Built-in roles cannot be deleted.');
    this.assertCovers(actor, r.permissions);
    const members = await this.prisma.adminUserRole.findMany({ where: { roleId: id }, select: { userId: true } });
    await this.prisma.$transaction(async (tx) => {
      await tx.role.delete({ where: { id } });
      if (r.permissions.includes('*')) await assertAdminRemains(tx);
    });
    await this.audit.record(actor, { action: 'role.delete', targetType: 'role', targetId: id, details: { name: r.name, members: members.length } });
  }
}
