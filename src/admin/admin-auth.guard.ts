import { CanActivate, ExecutionContext, Inject, Injectable, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { SessionsService } from '../auth/sessions.service';
import { APP_CONFIG, AppConfig } from '../config/config';
import { EventLogger } from '../common/event-logger';
import { GatewayError } from '../common/errors';
import { bearerToken, clientIp } from '../common/http';
import { AuthLimiterService } from '../keys/auth-limiter.service';
import { safeEqual } from '../keys/key-format';
import { hasPermission } from '../auth/permissions';
import { Actor } from './admin-audit.service';

export type AdminRequest = Request & { actor: Actor; sessionIdHash?: string };

export const PERM_KEY = 'mg:perm';
/**
 * RBAC: the caller needs ANY of the listed permissions. Routes without this decorator require "*".
 * `Authenticated()` (empty list) only requires a valid admin identity.
 */
export const RequirePermission = (...perms: string[]) => SetMetadata(PERM_KEY, perms);
export const Authenticated = () => SetMetadata(PERM_KEY, []);

/** Does the authenticated actor hold a permission? */
export const can = (actor: Actor | undefined, perm: string) => !!actor?.permissions && hasPermission(actor.permissions, perm);

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** Same-origin check for cookie-authenticated state-changing requests (defence in depth on top of SameSite=Strict + CSRF token). */
export function sameOrigin(req: Request, cfg: AppConfig): boolean {
  let origin = req.headers.origin;
  if (!origin && req.headers.referer) {
    try {
      origin = new URL(req.headers.referer).origin;
    } catch {
      return false;
    }
  }
  if (!origin) return false;
  const allowed = new Set<string>([`${req.protocol}://${req.get('host')}`]);
  if (cfg.PUBLIC_URL) allowed.add(new URL(cfg.PUBLIC_URL).origin);
  return allowed.has(origin);
}

/**
 * Admin authentication:
 *  1. Session cookie (humans; MFA completed). Mutations require X-CSRF-Token + same Origin.
 *  2. Static admin token (automation/CLI), only if ADMIN_TOKEN_ENABLED.
 * Authorization: RBAC permissions (union of the user's roles); the static token has "*".
 */
@Injectable()
export class AdminAuthGuard implements CanActivate {
  constructor(
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
    private readonly reflector: Reflector,
    private readonly limiter: AuthLimiterService,
    private readonly events: EventLogger,
    private readonly sessions: SessionsService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    if (!this.cfg.ADMIN_API_ENABLED) throw new GatewayError('NOT_FOUND', 'Not found');
    const req = ctx.switchToHttp().getRequest<AdminRequest>();
    const ip = clientIp(req);
    const blocked = await this.limiter.isBlocked('admin', ip);
    if (blocked) throw new GatewayError('AUTH_RATE_LIMITED', `Too many failed attempts. Retry in ${blocked}s.`, { retryAfterSeconds: blocked });

    const actor = (await this.fromSession(req, ip)) ?? this.fromToken(req, ip);
    if (!actor) {
      if (bearerToken(req)) {
        await this.limiter.recordFailure('admin', ip);
        this.events.emit('auth_failed', { ip, outcome: 'rejected', reason: 'INVALID_ADMIN_TOKEN', path: req.path });
      }
      throw new GatewayError('UNAUTHORIZED', 'Admin authentication required.');
    }
    const needed = this.reflector.getAllAndOverride<string[] | undefined>(PERM_KEY, [ctx.getHandler(), ctx.getClass()]) ?? ['*'];
    if (needed.length && !needed.some((p) => can(actor, p))) {
      throw new GatewayError('FORBIDDEN', `Missing permission: ${needed.join(' or ')}.`, { required: needed });
    }
    req.actor = actor;
    return true;
  }

  private async fromSession(req: AdminRequest, ip: string): Promise<Actor | null> {
    const token = this.sessions.readToken(req);
    if (!token) return null;
    const r = await this.sessions.resolve(token);
    if (!r) return null;
    if (!r.session.mfaPassed) throw new GatewayError('MFA_REQUIRED', 'Complete two-factor authentication first.');
    if (!SAFE_METHODS.has(req.method)) {
      const header = req.headers['x-csrf-token'];
      if (typeof header !== 'string' || !safeEqual(header, r.session.csrfToken) || !sameOrigin(req, this.cfg)) {
        this.events.emit('auth_failed', { ip, outcome: 'rejected', reason: 'CSRF_FAILED', path: req.path, user: r.user.email });
        throw new GatewayError('CSRF_FAILED', 'Missing or invalid CSRF token / origin.');
      }
    }
    req.sessionIdHash = r.session.idHash;
    return { type: 'user', id: r.user.id, label: r.user.email, ip, permissions: r.permissions };
  }

  private fromToken(req: Request, ip: string): Actor | null {
    const token = bearerToken(req);
    if (token && this.cfg.ADMIN_TOKEN_ENABLED && this.cfg.ADMIN_TOKEN && safeEqual(token, this.cfg.ADMIN_TOKEN)) {
      return { type: 'token', label: 'admin-token', ip, permissions: ['*'] };
    }
    return null;
  }
}
