import { Inject, Injectable } from '@nestjs/common';
import type { Redis } from 'ioredis';
import * as oidc from 'openid-client';
import { AdminAuditService } from '../admin/admin-audit.service';
import { APP_CONFIG, AppConfig } from '../config/config';
import { EventLogger } from '../common/event-logger';
import { GatewayError } from '../common/errors';
import { PrismaService } from '../common/prisma.service';
import { REDIS } from '../common/redis';
import { AdminRole } from '../generated/prisma/client';

export interface RoleMapping {
  role: AdminRole;
  canViewBodies: boolean;
}

/** Maps Authentik group names to a gateway role. No matching group → no access. */
export function mapGroups(groups: unknown, cfg: Pick<AppConfig, 'AUTHENTIK_ADMIN_GROUP' | 'AUTHENTIK_VIEWER_GROUP' | 'AUTHENTIK_BODIES_GROUP'>): RoleMapping | null {
  const g = Array.isArray(groups) ? groups.filter((x): x is string => typeof x === 'string') : typeof groups === 'string' ? [groups] : [];
  if (g.includes(cfg.AUTHENTIK_ADMIN_GROUP)) return { role: 'admin', canViewBodies: true };
  if (g.includes(cfg.AUTHENTIK_VIEWER_GROUP)) return { role: 'viewer', canViewBodies: g.includes(cfg.AUTHENTIK_BODIES_GROUP) };
  return null;
}

/** Authentik SSO via OpenID Connect (authorization code + PKCE + state + nonce). */
@Injectable()
export class AuthentikService {
  private config?: Promise<oidc.Configuration>;

  constructor(
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
    @Inject(REDIS) private readonly redis: Redis,
    private readonly prisma: PrismaService,
    private readonly audit: AdminAuditService,
    private readonly events: EventLogger,
  ) {}

  get enabled() {
    return this.cfg.AUTHENTIK_ENABLED;
  }

  get redirectUri() {
    return new URL('/admin/auth/authentik/callback', this.cfg.PUBLIC_URL).toString();
  }

  private discover(): Promise<oidc.Configuration> {
    if (!this.config) {
      this.config = oidc
        .discovery(
          new URL(this.cfg.AUTHENTIK_ISSUER!),
          this.cfg.AUTHENTIK_CLIENT_ID!,
          this.cfg.AUTHENTIK_CLIENT_SECRET!,
          undefined,
          this.cfg.AUTHENTIK_ALLOW_INSECURE ? { execute: [oidc.allowInsecureRequests] } : undefined,
        )
        .catch((e) => {
          this.config = undefined; // retry discovery next time
          throw e;
        });
    }
    return this.config;
  }

  /** Returns the authorization URL and the state to bind to the browser (cookie). */
  async start(): Promise<{ url: string; state: string }> {
    if (!this.enabled) throw new GatewayError('NOT_FOUND', 'SSO is not enabled.');
    const config = await this.discover();
    const verifier = oidc.randomPKCECodeVerifier();
    const state = oidc.randomState();
    const nonce = oidc.randomNonce();
    await this.redis.set(`mg:oidc:${state}`, JSON.stringify({ verifier, nonce }), 'EX', 600);
    const url = oidc.buildAuthorizationUrl(config, {
      redirect_uri: this.redirectUri,
      scope: this.cfg.AUTHENTIK_SCOPES,
      code_challenge: await oidc.calculatePKCECodeChallenge(verifier),
      code_challenge_method: 'S256',
      state,
      nonce,
    });
    return { url: url.toString(), state };
  }

  /** Completes the code flow and provisions/updates the user from the groups claim. */
  async callback(currentUrl: URL, cookieState: string | undefined, ip: string) {
    if (!this.enabled) throw new GatewayError('NOT_FOUND', 'SSO is not enabled.');
    const state = currentUrl.searchParams.get('state') ?? '';
    const err = currentUrl.searchParams.get('error');
    if (err) throw new GatewayError('SSO_ERROR', `Authentik returned an error: ${err}`);
    if (!state || !cookieState || state !== cookieState) throw new GatewayError('SSO_ERROR', 'Invalid SSO state (login CSRF protection). Start the login again.');
    const raw = await this.redis.getdel(`mg:oidc:${state}`);
    if (!raw) throw new GatewayError('SSO_ERROR', 'SSO login expired. Start the login again.');
    const { verifier, nonce } = JSON.parse(raw) as { verifier: string; nonce: string };
    const config = await this.discover();
    let tokens: Awaited<ReturnType<typeof oidc.authorizationCodeGrant>>;
    try {
      tokens = await oidc.authorizationCodeGrant(config, currentUrl, { pkceCodeVerifier: verifier, expectedState: state, expectedNonce: nonce, idTokenExpected: true });
    } catch (e) {
      throw new GatewayError('SSO_ERROR', `SSO token exchange failed: ${(e as Error).message}`);
    }
    const claims = tokens.claims();
    if (!claims) throw new GatewayError('SSO_ERROR', 'No ID token claims.');
    const sub = String(claims.sub);
    const email = String(claims.email ?? '').toLowerCase();
    const name = String(claims.name ?? claims.preferred_username ?? '');
    const mapping = mapGroups(claims[this.cfg.AUTHENTIK_GROUPS_CLAIM], this.cfg);
    const actor = { type: 'user' as const, label: email || sub, ip };

    if (!mapping) {
      await this.audit.record(actor, { action: 'auth.login', outcome: 'failure', details: { method: 'authentik', reason: 'no_mapped_group' } });
      this.events.emit('login_failed', { outcome: 'failure', reason: 'no_mapped_group', user: email, method: 'authentik', ip });
      throw new GatewayError('FORBIDDEN', 'Your Authentik account is not in a mail-gateway group. Ask an administrator for access.');
    }
    if (!email) throw new GatewayError('SSO_ERROR', 'Authentik did not provide an email claim (add the "email" scope).');

    let user = await this.prisma.adminUser.findUnique({ where: { oidcSubject: sub } });
    if (!user) {
      const byEmail = await this.prisma.adminUser.findUnique({ where: { email } });
      if (byEmail) {
        // Never silently link SSO to an existing local account (account takeover risk).
        await this.audit.record(actor, { action: 'auth.login', outcome: 'failure', details: { method: 'authentik', reason: 'email_conflict' } });
        throw new GatewayError('FORBIDDEN', `A local account with ${email} already exists. An administrator must remove it before SSO login is possible.`);
      }
      user = await this.prisma.adminUser.create({
        data: { email, name, role: mapping.role, canViewBodies: mapping.canViewBodies, authSource: 'authentik', oidcSubject: sub },
      });
      await this.audit.record(actor, { action: 'user.provisioned', targetType: 'admin_user', targetId: user.id, details: { role: mapping.role, method: 'authentik' } });
    } else {
      if (user.disabled) {
        await this.audit.record(actor, { action: 'auth.login', outcome: 'failure', targetId: user.id, details: { method: 'authentik', reason: 'disabled' } });
        throw new GatewayError('FORBIDDEN', 'Your account is disabled.');
      }
      if (user.role !== mapping.role || user.canViewBodies !== mapping.canViewBodies || user.email !== email) {
        await this.audit.record(actor, {
          action: 'user.role_synced',
          targetType: 'admin_user',
          targetId: user.id,
          details: { from: { role: user.role, canViewBodies: user.canViewBodies }, to: mapping },
        });
      }
      user = await this.prisma.adminUser.update({ where: { id: user.id }, data: { role: mapping.role, canViewBodies: mapping.canViewBodies, email, name } });
    }
    user = await this.prisma.adminUser.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
    await this.audit.record({ ...actor, id: user.id }, { action: 'auth.login', targetType: 'admin_user', targetId: user.id, details: { method: 'authentik' } });
    this.events.emit('login_succeeded', { outcome: 'success', user: email, method: 'authentik', ip });
    return { user, idToken: tokens.id_token };
  }

  async endSessionUrl(idTokenHint: string | null): Promise<string | null> {
    if (!this.enabled || !idTokenHint) return null;
    try {
      const config = await this.discover();
      if (!config.serverMetadata().end_session_endpoint) return null;
      return oidc
        .buildEndSessionUrl(config, { id_token_hint: idTokenHint, post_logout_redirect_uri: new URL('/ui/login', this.cfg.PUBLIC_URL).toString() })
        .toString();
    } catch {
      return null;
    }
  }
}
