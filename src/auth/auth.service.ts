import { Inject, Injectable } from '@nestjs/common';
import * as QRCode from 'qrcode';
import { AdminAuditService } from '../admin/admin-audit.service';
import { APP_CONFIG, AppConfig } from '../config/config';
import { EventLogger } from '../common/event-logger';
import { GatewayError } from '../common/errors';
import { PrismaService } from '../common/prisma.service';
import { AdminSession, AdminUser } from '../generated/prisma/client';
import { AuthLimiterService } from '../keys/auth-limiter.service';
import { SecretBox } from './crypto';
import { verifyPassword } from './password';
import { SessionsService } from './sessions.service';
import { generateTotpSecret, otpauthUri, verifyTotp } from './totp';

interface Meta {
  ip: string;
  userAgent?: string;
}

/** Local login: password (argon2id) → mandatory TOTP. Lockout per account and rate limit per IP. */
@Injectable()
export class AuthService {
  constructor(
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
    private readonly prisma: PrismaService,
    private readonly sessions: SessionsService,
    private readonly box: SecretBox,
    private readonly limiter: AuthLimiterService,
    private readonly audit: AdminAuditService,
    private readonly events: EventLogger,
  ) {}

  private async ipGate(ip: string) {
    const blocked = await this.limiter.isBlocked('login', ip, this.cfg.LOGIN_IP_MAX);
    if (blocked) throw new GatewayError('AUTH_RATE_LIMITED', `Too many login attempts. Retry in ${blocked}s.`, { retryAfterSeconds: blocked });
  }

  private async fail(user: AdminUser | null, email: string, reason: string, meta: Meta) {
    await this.limiter.recordFailure('login', meta.ip, this.cfg.LOGIN_IP_WINDOW_SECONDS);
    let locked = false;
    if (user) {
      const failed = user.failedLogins + 1;
      locked = failed >= this.cfg.LOGIN_MAX_FAILURES;
      await this.prisma.adminUser.update({
        where: { id: user.id },
        data: { failedLogins: locked ? 0 : failed, ...(locked ? { lockedUntil: new Date(Date.now() + this.cfg.LOGIN_LOCKOUT_MINUTES * 60_000) } : {}) },
      });
    }
    await this.audit.record(
      { type: 'user', id: user?.id, label: email.slice(0, 254), ip: meta.ip },
      { action: 'auth.login', outcome: 'failure', targetType: 'admin_user', targetId: user?.id, details: { reason, locked } },
    );
    this.events.emit('login_failed', { outcome: 'failure', reason, user: email.slice(0, 254), ip: meta.ip, locked });
  }

  private assertNotLocked(user: AdminUser) {
    if (user.lockedUntil && user.lockedUntil.getTime() > Date.now()) {
      const s = Math.ceil((user.lockedUntil.getTime() - Date.now()) / 1000);
      throw new GatewayError('ACCOUNT_LOCKED', `Account temporarily locked after repeated failures. Retry in ${s}s.`, { retryAfterSeconds: s });
    }
  }

  async login(email: unknown, password: unknown, meta: Meta) {
    if (!this.cfg.LOCAL_LOGIN_ENABLED) throw new GatewayError('FORBIDDEN', 'Local login is disabled. Use single sign-on.');
    if (!this.box.available) throw new GatewayError('INTERNAL_ERROR', 'APP_ENCRYPTION_KEY is not configured.');
    await this.ipGate(meta.ip);
    if (typeof email !== 'string' || typeof password !== 'string' || !email || !password || password.length > 256) {
      throw new GatewayError('VALIDATION_FAILED', 'email and password are required.');
    }
    const normalized = email.trim().toLowerCase();
    const user = await this.prisma.adminUser.findUnique({ where: { email: normalized } });
    if (user) this.assertNotLocked(user);
    const ok = await verifyPassword(user?.authSource === 'local' && !user.disabled ? user.passwordHash : null, password);
    if (!user || !ok) {
      await this.fail(user && user.authSource === 'local' ? user : null, normalized, 'bad_password', meta);
      throw new GatewayError('INVALID_CREDENTIALS', 'Invalid email or password.');
    }
    // Second factor: required when the user enabled TOTP, or for everyone when TOTP_REQUIRED=true.
    if (user.totpEnrolled || this.cfg.TOTP_REQUIRED) {
      const { token } = await this.sessions.create(user, { mfaPassed: false, ...meta });
      return { token, next: user.totpEnrolled ? ('totp_verify' as const) : ('totp_enroll' as const) };
    }
    // Password-only login (TOTP optional and not enabled by this user). `mfaPassed` = fully authenticated.
    const updated = await this.prisma.adminUser.update({
      where: { id: user.id },
      data: { failedLogins: 0, lockedUntil: null, lastLoginAt: new Date() },
    });
    const full = await this.sessions.create(updated, { mfaPassed: true, ...meta });
    await this.audit.record({ type: 'user', id: user.id, label: user.email, ip: meta.ip }, { action: 'auth.login', targetType: 'admin_user', targetId: user.id, details: { method: 'password' } });
    this.events.emit('login_succeeded', { outcome: 'success', user: user.email, method: 'password', ip: meta.ip });
    return { token: full.token, next: 'done' as const, session: full.session, user: updated };
  }

  // ------------------------------------------------------------ self-service 2FA (signed-in users)

  private assertLocal(user: AdminUser) {
    if (user.authSource !== 'local') throw new GatewayError('INVALID_STATE', 'Two-factor authentication for SSO users is managed by Authentik.');
  }

  /** Starts enrollment: stores a new encrypted secret that becomes active only after confirm(). */
  async accountTotpSetup(user: AdminUser) {
    this.assertLocal(user);
    if (user.totpEnrolled) throw new GatewayError('INVALID_STATE', 'Two-factor authentication is already enabled.');
    const secret = generateTotpSecret();
    await this.prisma.adminUser.update({ where: { id: user.id }, data: { totpSecretEnc: this.box.seal(secret), totpLastStep: null } });
    const uri = otpauthUri(secret, user.email);
    return { secret, otpauthUri: uri, qrDataUrl: await QRCode.toDataURL(uri, { margin: 1, width: 220 }) };
  }

  async accountTotpConfirm(user: AdminUser, code: unknown, meta: Meta) {
    this.assertLocal(user);
    if (user.totpEnrolled) throw new GatewayError('INVALID_STATE', 'Two-factor authentication is already enabled.');
    if (!user.totpSecretEnc) throw new GatewayError('INVALID_STATE', 'Start the setup first.');
    const step = typeof code === 'string' ? verifyTotp(this.box.open(user.totpSecretEnc), code.trim()) : null;
    if (step === null) throw new GatewayError('INVALID_CREDENTIALS', 'Invalid authentication code. Check the time on your device and try again.');
    const updated = await this.prisma.adminUser.update({ where: { id: user.id }, data: { totpEnrolled: true, totpLastStep: step } });
    await this.audit.record({ type: 'user', id: user.id, label: user.email, ip: meta.ip }, { action: 'auth.totp_enrolled', targetType: 'admin_user', targetId: user.id });
    return updated;
  }

  /** Turning 2FA off requires the current password (re-authentication). Refused when TOTP_REQUIRED. */
  async accountTotpDisable(user: AdminUser, password: unknown, meta: Meta) {
    this.assertLocal(user);
    if (this.cfg.TOTP_REQUIRED) throw new GatewayError('INVALID_STATE', 'Two-factor authentication is required by the gateway policy and cannot be disabled.');
    if (!user.totpEnrolled) throw new GatewayError('INVALID_STATE', 'Two-factor authentication is not enabled.');
    this.assertNotLocked(user);
    if (typeof password !== 'string' || !(await verifyPassword(user.passwordHash, password))) {
      await this.fail(user, user.email, 'bad_password_totp_disable', meta);
      throw new GatewayError('INVALID_CREDENTIALS', 'Current password is incorrect.');
    }
    const updated = await this.prisma.adminUser.update({ where: { id: user.id }, data: { totpEnrolled: false, totpSecretEnc: null, totpLastStep: null } });
    await this.audit.record({ type: 'user', id: user.id, label: user.email, ip: meta.ip }, { action: 'auth.totp_disabled', targetType: 'admin_user', targetId: user.id });
    return updated;
  }

  /** First login: generate a TOTP secret (stored encrypted, not active until verified). */
  async enrollStart(session: AdminSession, user: AdminUser) {
    if (session.mfaPassed || user.totpEnrolled) throw new GatewayError('INVALID_STATE', 'Two-factor authentication is already set up.');
    const secret = generateTotpSecret();
    await this.prisma.adminUser.update({ where: { id: user.id }, data: { totpSecretEnc: this.box.seal(secret) } });
    const uri = otpauthUri(secret, user.email);
    return { secret, otpauthUri: uri, qrDataUrl: await QRCode.toDataURL(uri, { margin: 1, width: 220 }) };
  }

  async verify(session: AdminSession, user: AdminUser, code: unknown, meta: Meta) {
    if (session.mfaPassed) throw new GatewayError('INVALID_STATE', 'Already verified.');
    await this.ipGate(meta.ip);
    this.assertNotLocked(user);
    if (!user.totpSecretEnc) throw new GatewayError('INVALID_STATE', 'Set up two-factor authentication first.');
    const step = typeof code === 'string' ? verifyTotp(this.box.open(user.totpSecretEnc), code.trim()) : null;
    if (step === null || (user.totpLastStep !== null && step <= user.totpLastStep)) {
      await this.fail(user, user.email, step === null ? 'bad_totp' : 'totp_replay', meta);
      throw new GatewayError('INVALID_CREDENTIALS', 'Invalid authentication code.');
    }
    const updated = await this.prisma.adminUser.update({
      where: { id: user.id },
      data: { totpEnrolled: true, totpLastStep: step, failedLogins: 0, lockedUntil: null, lastLoginAt: new Date() },
    });
    const full = await this.sessions.upgrade(session, updated, meta);
    if (!user.totpEnrolled) {
      await this.audit.record({ type: 'user', id: user.id, label: user.email, ip: meta.ip }, { action: 'auth.totp_enrolled', targetType: 'admin_user', targetId: user.id });
    }
    await this.audit.record({ type: 'user', id: user.id, label: user.email, ip: meta.ip }, { action: 'auth.login', targetType: 'admin_user', targetId: user.id, details: { method: 'password+totp' } });
    this.events.emit('login_succeeded', { outcome: 'success', user: user.email, method: 'password+totp', ip: meta.ip });
    return full;
  }
}
