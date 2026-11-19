// Authored by Tomás Neto (TN 2026)
import { Inject, Injectable } from '@nestjs/common';
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type AuthenticatorTransport,
  type RegistrationResponseJSON,
} from '@simplewebauthn/server';
import type { Request } from 'express';
import type { Redis } from 'ioredis';
import { AdminAuditService } from '../admin/admin-audit.service';
import { APP_CONFIG, AppConfig } from '../config/config';
import { GatewayError } from '../common/errors';
import { PrismaService } from '../common/prisma.service';
import { REDIS } from '../common/redis';
import { AdminPasskey, AdminUser } from '../generated/prisma/client';

const CHALLENGE_TTL = 300;

export interface PasskeyView {
  id: string;
  name: string;
  createdAt: string;
  lastUsedAt: string | null;
}

const toView = (p: AdminPasskey): PasskeyView => ({ id: p.id, name: p.name, createdAt: p.createdAt.toISOString(), lastUsedAt: p.lastUsedAt?.toISOString() ?? null });

/**
 * WebAuthn passkeys / security keys as a second factor for local accounts. The relying party is
 * PUBLIC_URL's host (or the request host when unset); browsers only allow it over HTTPS or on localhost.
 */
@Injectable()
export class PasskeysService {
  constructor(
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
    @Inject(REDIS) private readonly redis: Redis,
    private readonly prisma: PrismaService,
    private readonly audit: AdminAuditService,
  ) {}

  rp(req: Request): { rpID: string; origin: string } {
    if (this.cfg.PUBLIC_URL) {
      const u = new URL(this.cfg.PUBLIC_URL);
      return { rpID: u.hostname, origin: u.origin };
    }
    const host = req.get('host') ?? 'localhost';
    return { rpID: host.replace(/:\d+$/, ''), origin: `${req.protocol}://${host}` };
  }

  list(userId: string) {
    return this.prisma.adminPasskey.findMany({ where: { userId }, orderBy: { createdAt: 'asc' } }).then((r) => r.map(toView));
  }

  count(userId: string) {
    return this.prisma.adminPasskey.count({ where: { userId } });
  }

  async registrationOptions(user: AdminUser, req: Request) {
    if (user.authSource !== 'local') throw new GatewayError('INVALID_STATE', 'Passkeys are for local accounts; SSO users sign in through Authentik.');
    const { rpID } = this.rp(req);
    const existing = await this.prisma.adminPasskey.findMany({ where: { userId: user.id } });
    const opts = await generateRegistrationOptions({
      rpName: 'mail-gateway',
      rpID,
      userName: user.email,
      userDisplayName: user.name || user.email,
      userID: new TextEncoder().encode(user.id),
      attestationType: 'none',
      excludeCredentials: existing.map((p) => ({ id: p.credentialId, transports: p.transports as AuthenticatorTransport[] })),
      authenticatorSelection: { residentKey: 'preferred', userVerification: 'preferred' },
    });
    await this.redis.set(`mg:webauthn:reg:${user.id}`, opts.challenge, 'EX', CHALLENGE_TTL);
    return opts;
  }

  async register(user: AdminUser, response: unknown, name: unknown, req: Request, ip: string): Promise<PasskeyView> {
    const challenge = await this.redis.getdel(`mg:webauthn:reg:${user.id}`);
    if (!challenge) throw new GatewayError('INVALID_STATE', 'The registration expired. Start again.');
    const { rpID, origin } = this.rp(req);
    let v: Awaited<ReturnType<typeof verifyRegistrationResponse>>;
    try {
      v = await verifyRegistrationResponse({ response: response as RegistrationResponseJSON, expectedChallenge: challenge, expectedOrigin: origin, expectedRPID: rpID, requireUserVerification: false });
    } catch (e) {
      throw new GatewayError('VALIDATION_FAILED', `The passkey could not be verified: ${(e as Error).message}`);
    }
    if (!v.verified || !v.registrationInfo) throw new GatewayError('VALIDATION_FAILED', 'The passkey could not be verified.');
    const c = v.registrationInfo.credential;
    const label = typeof name === 'string' && name.trim() ? name.trim().slice(0, 60) : 'Passkey';
    const pk = await this.prisma.adminPasskey.create({
      data: { userId: user.id, credentialId: c.id, publicKey: new Uint8Array(c.publicKey), counter: BigInt(c.counter), transports: c.transports ?? [], name: label },
    });
    await this.audit.record({ type: 'user', id: user.id, label: user.email, ip }, { action: 'auth.passkey_added', targetType: 'admin_user', targetId: user.id, details: { name: label } });
    return toView(pk);
  }

  async remove(user: AdminUser, id: string, ip: string) {
    const pk = /^[0-9a-f-]{36}$/i.test(id) ? await this.prisma.adminPasskey.findFirst({ where: { id, userId: user.id } }) : null;
    if (!pk) throw new GatewayError('NOT_FOUND', 'Passkey not found.');
    if (this.cfg.TOTP_REQUIRED && !user.totpEnrolled && (await this.count(user.id)) <= 1) {
      throw new GatewayError('INVALID_STATE', 'Two-factor authentication is required: set up an authenticator app before removing your last passkey.');
    }
    await this.prisma.adminPasskey.delete({ where: { id } });
    await this.audit.record({ type: 'user', id: user.id, label: user.email, ip }, { action: 'auth.passkey_removed', targetType: 'admin_user', targetId: user.id, details: { name: pk.name } });
  }

  /** Second factor at sign-in: challenge bound to the pre-MFA session. */
  async authenticationOptions(user: AdminUser, sessionIdHash: string, req: Request) {
    const { rpID } = this.rp(req);
    const keys = await this.prisma.adminPasskey.findMany({ where: { userId: user.id } });
    if (!keys.length) throw new GatewayError('INVALID_STATE', 'No passkey registered for this account.');
    const opts = await generateAuthenticationOptions({
      rpID,
      allowCredentials: keys.map((p) => ({ id: p.credentialId, transports: p.transports as AuthenticatorTransport[] })),
      userVerification: 'preferred',
    });
    await this.redis.set(`mg:webauthn:auth:${sessionIdHash}`, opts.challenge, 'EX', CHALLENGE_TTL);
    return opts;
  }

  /** true when the assertion is valid for one of the user's passkeys. */
  async verifyAuthentication(user: AdminUser, response: unknown, sessionIdHash: string, req: Request): Promise<boolean> {
    const challenge = await this.redis.getdel(`mg:webauthn:auth:${sessionIdHash}`);
    if (!challenge) return false;
    const r = response as AuthenticationResponseJSON;
    if (!r || typeof r.id !== 'string') return false;
    const pk = await this.prisma.adminPasskey.findFirst({ where: { userId: user.id, credentialId: r.id } });
    if (!pk) return false;
    const { rpID, origin } = this.rp(req);
    try {
      const v = await verifyAuthenticationResponse({
        response: r,
        expectedChallenge: challenge,
        expectedOrigin: origin,
        expectedRPID: rpID,
        credential: { id: pk.credentialId, publicKey: new Uint8Array(pk.publicKey), counter: Number(pk.counter), transports: pk.transports as AuthenticatorTransport[] },
        requireUserVerification: false,
      });
      if (!v.verified) return false;
      await this.prisma.adminPasskey.update({ where: { id: pk.id }, data: { counter: BigInt(v.authenticationInfo.newCounter), lastUsedAt: new Date() } });
      return true;
    } catch {
      return false;
    }
  }
}
