// Authored by Tomás Neto (TN 2026)
import { Inject, Injectable } from '@nestjs/common';
import type { Request, Response } from 'express';
import { APP_CONFIG, AppConfig } from '../config/config';
import { GatewayError } from '../common/errors';
import { PrismaService } from '../common/prisma.service';
import { AdminSession, AdminUser, Role } from '../generated/prisma/client';
import { effectivePermissions } from './permissions';
import { randomToken, sha256hex } from './crypto';

const PARTIAL_TTL_MS = 10 * 60_000;

export type UserWithRoles = AdminUser & { roles: Array<{ role: Role }> };

export interface ResolvedSession {
  session: AdminSession;
  user: UserWithRoles;
  /** effective RBAC permissions (union of the user's roles) */
  permissions: string[];
}

/** Server-side sessions. The cookie holds a random token; the DB stores only its SHA-256. */
@Injectable()
export class SessionsService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
  ) {}

  get cookieName() {
    // __Host- prefix: Secure, Path=/, no Domain → cannot be set/overwritten by subdomains.
    return this.cfg.COOKIE_SECURE ? '__Host-mg_session' : 'mg_session';
  }

  async create(user: AdminUser, opts: { mfaPassed: boolean; ip?: string; userAgent?: string; idTokenHint?: string }) {
    const token = randomToken(32);
    const csrfToken = randomToken(24);
    const ttl = opts.mfaPassed ? this.cfg.SESSION_TTL_HOURS * 3600_000 : PARTIAL_TTL_MS;
    const session = await this.prisma.adminSession.create({
      data: {
        idHash: sha256hex(token),
        userId: user.id,
        mfaPassed: opts.mfaPassed,
        csrfToken,
        ip: opts.ip ?? null,
        userAgent: opts.userAgent?.slice(0, 300) ?? null,
        idTokenHint: opts.idTokenHint ?? null,
        expiresAt: new Date(Date.now() + ttl),
      },
    });
    return { token, session };
  }

  async resolve(token: string | undefined): Promise<ResolvedSession | null> {
    if (!token || token.length > 100) return null;
    const idHash = sha256hex(token);
    const session = await this.prisma.adminSession.findUnique({
      where: { idHash },
      include: { user: { include: { roles: { include: { role: true } } } } },
    });
    if (!session) return null;
    const now = Date.now();
    const idleExpired = session.mfaPassed && now - session.lastSeenAt.getTime() > this.cfg.SESSION_IDLE_MINUTES * 60_000;
    if (session.expiresAt.getTime() < now || idleExpired || session.user.disabled) {
      await this.prisma.adminSession.delete({ where: { idHash } }).catch(() => undefined);
      return null;
    }
    if (now - session.lastSeenAt.getTime() > 60_000) {
      await this.prisma.adminSession.update({ where: { idHash }, data: { lastSeenAt: new Date() } }).catch(() => undefined);
    }
    const { user, ...s } = session;
    return { session: s as AdminSession, user, permissions: effectivePermissions(user.roles.map((r) => r.role)) };
  }

  /** Upgrade after MFA: issue a fresh session id (prevents session fixation). */
  async upgrade(old: AdminSession, user: AdminUser, meta: { ip?: string; userAgent?: string }) {
    await this.destroy(old.idHash);
    return this.create(user, { mfaPassed: true, ...meta });
  }

  async destroy(idHash: string) {
    await this.prisma.adminSession.deleteMany({ where: { idHash } });
  }

  async destroyAllForUser(userId: string) {
    await this.prisma.adminSession.deleteMany({ where: { userId } });
  }

  /** The user's signed-in sessions (pre-MFA ones are not listed). */
  async listForUser(userId: string, currentIdHash?: string) {
    const rows = await this.prisma.adminSession.findMany({ where: { userId, mfaPassed: true, expiresAt: { gt: new Date() } }, orderBy: { lastSeenAt: 'desc' } });
    return rows.map((s) => ({
      id: s.idHash,
      current: s.idHash === currentIdHash,
      ip: s.ip,
      userAgent: s.userAgent,
      createdAt: s.createdAt.toISOString(),
      lastSeenAt: s.lastSeenAt.toISOString(),
      expiresAt: s.expiresAt.toISOString(),
    }));
  }

  async revokeForUser(userId: string, idHash: string) {
    const res = await this.prisma.adminSession.deleteMany({ where: { userId, idHash } });
    if (!res.count) throw new GatewayError('NOT_FOUND', 'Session not found.');
  }

  async revokeOthers(userId: string, keepIdHash?: string): Promise<number> {
    const res = await this.prisma.adminSession.deleteMany({ where: { userId, ...(keepIdHash ? { NOT: { idHash: keepIdHash } } : {}) } });
    return res.count;
  }

  readToken(req: Request): string | undefined {
    const c = (req as Request & { cookies?: Record<string, string> }).cookies;
    return c?.[this.cookieName];
  }

  setCookie(res: Response, token: string, mfaPassed: boolean) {
    res.cookie(this.cookieName, token, {
      httpOnly: true,
      secure: this.cfg.COOKIE_SECURE,
      sameSite: 'strict',
      path: '/',
      maxAge: mfaPassed ? this.cfg.SESSION_TTL_HOURS * 3600_000 : PARTIAL_TTL_MS,
    });
  }

  clearCookie(res: Response) {
    res.clearCookie(this.cookieName, { httpOnly: true, secure: this.cfg.COOKIE_SECURE, sameSite: 'strict', path: '/' });
  }
}
