// Authored by Tomás Neto (TN 2026)
import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Post, Req, Res, UseGuards } from '@nestjs/common';
import { ApiBody, ApiCookieAuth, ApiOkResponse, ApiOperation, ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { AdminAuditService } from '../admin/admin-audit.service';
import { AdminAuthGuard, AdminRequest, Authenticated, sameOrigin } from '../admin/admin-auth.guard';
import { APP_CONFIG, AppConfig } from '../config/config';
import { GatewayError } from '../common/errors';
import { clientIp } from '../common/http';
import { AuthService, secondFactorMethods, secondFactorStep } from './auth.service';
import { PasskeysService } from './passkeys.service';
import { AuthentikService } from './authentik.service';
import { SessionsService } from './sessions.service';
import { UsersService, toUserView } from './users.service';
import { UserDto } from '../admin/admin.dto';

const OIDC_STATE_COOKIE = 'mg_oidc_state';

class LoginBody {
  @ApiProperty() email!: string;
  @ApiProperty() password!: string;
}
class CodeBody {
  @ApiProperty({ description: '6-digit code from the authenticator app' }) code!: string;
}
class PasswordBody {
  @ApiProperty({ description: 'At least 12 characters' }) password!: string;
}
class AuthConfigDto {
  @ApiProperty() localLogin!: boolean;
  @ApiProperty() authentik!: boolean;
  @ApiProperty({ description: 'true when every local user must use TOTP' }) totpRequired!: boolean;
}
class LoginResultDto {
  @ApiProperty({
    enum: ['done', 'totp_enroll', 'totp_verify', 'second_factor'],
    description:
      'done: signed in (no 2FA for this user). totp_verify: enter the TOTP code. totp_enroll: 2FA is mandatory and must be set up now. ' +
      'second_factor: the user has a passkey; use one of `methods` (passkey via /admin/auth/passkey/*, totp via /admin/auth/totp/verify).',
  })
  next!: 'done' | 'totp_enroll' | 'totp_verify' | 'second_factor';
  @ApiPropertyOptional({ type: [String], enum: ['passkey', 'totp'], description: 'Second-factor methods available (when next is not done)' })
  methods?: Array<'passkey' | 'totp'>;
  @ApiPropertyOptional({ type: () => UserDto, description: 'Present when next=done' }) user?: UserDto;
  @ApiPropertyOptional({ description: 'Present when next=done' }) csrfToken?: string;
}
class TotpEnrollDto {
  @ApiProperty() secret!: string;
  @ApiProperty() otpauthUri!: string;
  @ApiProperty({ description: 'PNG data URL of the QR code' }) qrDataUrl!: string;
}
class SessionDto {
  @ApiProperty({ type: UserDto }) user!: UserDto;
  @ApiProperty({ description: 'Send as X-CSRF-Token on every state-changing request' }) csrfToken!: string;
}
class LogoutDto {
  @ApiPropertyOptional({ type: String, nullable: true, description: 'Authentik end-session URL to visit, if any' }) redirect!: string | null;
}
class InviteInfoDto {
  @ApiProperty() email!: string;
}
class OkDto {
  @ApiProperty() ok!: boolean;
}
class ChangePasswordBody {
  @ApiProperty() currentPassword!: string;
  @ApiProperty({ description: 'At least 12 characters' }) newPassword!: string;
}
class PasswordChangedDto {
  @ApiProperty({ description: 'Other sessions that were signed out' }) otherSessionsRevoked!: number;
}
class AccountSessionDto {
  @ApiProperty({ description: 'Opaque session id (hash of the cookie)' }) id!: string;
  @ApiProperty() current!: boolean;
  @ApiProperty({ type: String, nullable: true }) ip!: string | null;
  @ApiProperty({ type: String, nullable: true }) userAgent!: string | null;
  @ApiProperty() createdAt!: string;
  @ApiProperty() lastSeenAt!: string;
  @ApiProperty() expiresAt!: string;
}
class RevokedDto {
  @ApiProperty() revoked!: number;
}
class PasskeyDto {
  @ApiProperty() id!: string;
  @ApiProperty() name!: string;
  @ApiProperty() createdAt!: string;
  @ApiProperty({ type: String, nullable: true }) lastUsedAt!: string | null;
}

const meta = (req: Request) => ({ ip: clientIp(req), userAgent: req.headers['user-agent'] });

/** Human authentication for the admin UI. */
@ApiTags('auth')
@Controller('admin/auth')
export class AuthController {
  constructor(
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
    private readonly auth: AuthService,
    private readonly sessions: SessionsService,
    private readonly users: UsersService,
    private readonly authentik: AuthentikService,
    private readonly audit: AdminAuditService,
    private readonly passkeys: PasskeysService,
  ) {}

  private requireOrigin(req: Request) {
    if (!sameOrigin(req, this.cfg)) throw new GatewayError('CSRF_FAILED', 'Cross-origin request rejected.');
  }

  private async partial(req: Request) {
    const r = await this.sessions.resolve(this.sessions.readToken(req));
    if (!r) throw new GatewayError('UNAUTHORIZED', 'Session expired. Log in again.');
    return r;
  }

  @Get('config')
  @ApiOperation({ operationId: 'authConfig' })
  @ApiOkResponse({ type: AuthConfigDto })
  config(): AuthConfigDto {
    return { localLogin: this.cfg.LOCAL_LOGIN_ENABLED, authentik: this.cfg.AUTHENTIK_ENABLED, totpRequired: this.cfg.TOTP_REQUIRED };
  }

  @Post('login')
  @HttpCode(200)
  @ApiOperation({
    operationId: 'authLogin',
    summary: 'Email + password. Signs in directly (next=done) or sets a short-lived pre-MFA session when a TOTP code is needed.',
  })
  @ApiOkResponse({ type: LoginResultDto })
  async login(@Req() req: Request, @Res({ passthrough: true }) res: Response, @Body() body: LoginBody): Promise<LoginResultDto> {
    this.requireOrigin(req);
    const r = await this.auth.login(body?.email, body?.password, meta(req));
    if (r.next === 'done') {
      this.sessions.setCookie(res, r.token, true);
      return { next: 'done', user: toUserView(await this.users.getFull(r.user.id)), csrfToken: r.session.csrfToken };
    }
    this.sessions.setCookie(res, r.token, false);
    return r.next === 'second_factor' ? { next: r.next, methods: r.methods } : { next: r.next };
  }

  @Post('passkey/options')
  @HttpCode(200)
  @ApiOperation({ operationId: 'authPasskeyOptions', summary: 'Step 2 with a passkey: WebAuthn request options for navigator.credentials.get().' })
  @ApiOkResponse({ schema: { type: 'object', additionalProperties: true } })
  async passkeyOptions(@Req() req: Request) {
    this.requireOrigin(req);
    const { session, user } = await this.partial(req);
    if (session.mfaPassed) throw new GatewayError('INVALID_STATE', 'Already verified.');
    return this.passkeys.authenticationOptions(user, session.idHash, req);
  }

  @Post('passkey/verify')
  @HttpCode(200)
  @ApiOperation({ operationId: 'authPasskeyVerify', summary: 'Step 2 with a passkey: verify the assertion. Issues the full session cookie.' })
  @ApiBody({ schema: { type: 'object', properties: { response: { type: 'object', additionalProperties: true } }, required: ['response'] } })
  @ApiOkResponse({ type: SessionDto })
  async passkeyVerify(@Req() req: Request, @Res({ passthrough: true }) res: Response, @Body() body: { response?: unknown }): Promise<SessionDto> {
    this.requireOrigin(req);
    const { session, user } = await this.partial(req);
    const full = await this.auth.verifyPasskey(session, user, body?.response, req, meta(req));
    this.sessions.setCookie(res, full.token, true);
    return { user: toUserView(await this.users.getFull(user.id)), csrfToken: full.session.csrfToken };
  }

  @Post('totp/enroll')
  @HttpCode(200)
  @ApiOperation({ operationId: 'authTotpEnroll', summary: 'Step 2a (first login): get a TOTP secret + QR code.' })
  @ApiOkResponse({ type: TotpEnrollDto })
  async enroll(@Req() req: Request): Promise<TotpEnrollDto> {
    this.requireOrigin(req);
    const { session, user } = await this.partial(req);
    return this.auth.enrollStart(session, user);
  }

  @Post('totp/verify')
  @HttpCode(200)
  @ApiOperation({ operationId: 'authTotpVerify', summary: 'Step 2: verify the TOTP code. Issues the full session cookie.' })
  @ApiOkResponse({ type: SessionDto })
  async verify(@Req() req: Request, @Res({ passthrough: true }) res: Response, @Body() body: CodeBody): Promise<SessionDto> {
    this.requireOrigin(req);
    const { session, user } = await this.partial(req);
    const full = await this.auth.verify(session, user, body?.code, meta(req));
    this.sessions.setCookie(res, full.token, true);
    return { user: toUserView(await this.users.getFull(user.id)), csrfToken: full.session.csrfToken };
  }

  @Get('session')
  @ApiOperation({ operationId: 'authSession', summary: 'Current user + CSRF token. 401 when not logged in.' })
  @ApiOkResponse({ type: SessionDto })
  async session(@Req() req: Request): Promise<SessionDto> {
    const r = await this.sessions.resolve(this.sessions.readToken(req));
    if (!r) throw new GatewayError('UNAUTHORIZED', 'Not logged in.');
    if (!r.session.mfaPassed) {
      const n = await this.passkeys.count(r.user.id);
      throw new GatewayError('MFA_REQUIRED', 'Complete two-factor authentication.', { next: secondFactorStep(r.user, n), methods: secondFactorMethods(r.user, n) });
    }
    return { user: toUserView(r.user), csrfToken: r.session.csrfToken };
  }

  @Post('logout')
  @HttpCode(200)
  @ApiOperation({ operationId: 'authLogout' })
  @ApiOkResponse({ type: LogoutDto })
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response): Promise<LogoutDto> {
    this.requireOrigin(req);
    const r = await this.sessions.resolve(this.sessions.readToken(req));
    this.sessions.clearCookie(res);
    if (!r) return { redirect: null };
    await this.sessions.destroy(r.session.idHash);
    await this.audit.record({ type: 'user', id: r.user.id, label: r.user.email, ip: clientIp(req) }, { action: 'auth.logout', targetType: 'admin_user', targetId: r.user.id });
    return { redirect: await this.authentik.endSessionUrl(r.session.idTokenHint) };
  }

  @Get('invite/:token')
  @ApiOperation({ operationId: 'authInviteInfo' })
  @ApiOkResponse({ type: InviteInfoDto })
  async inviteInfo(@Param('token') token: string): Promise<InviteInfoDto> {
    const inv = await this.users.inviteInfo(token);
    return { email: inv.user.email };
  }

  @Post('invite/:token')
  @HttpCode(200)
  @ApiOperation({ operationId: 'authInviteAccept', summary: 'Set the password from an invite link. Then log in and enroll TOTP.' })
  @ApiOkResponse({ type: InviteInfoDto })
  async acceptInvite(@Req() req: Request, @Param('token') token: string, @Body() body: PasswordBody): Promise<InviteInfoDto> {
    this.requireOrigin(req);
    return this.users.acceptInvite(token, body?.password, clientIp(req));
  }

  @Get('authentik/login')
  @ApiOperation({ operationId: 'authAuthentikLogin', summary: 'Redirects to Authentik.' })
  async authentikLogin(@Res() res: Response) {
    const { url, state } = await this.authentik.start();
    res.cookie(OIDC_STATE_COOKIE, state, {
      httpOnly: true,
      secure: this.cfg.COOKIE_SECURE,
      // Lax: the cookie must survive the top-level redirect back from Authentik.
      sameSite: 'lax',
      path: '/admin/auth/authentik',
      maxAge: 600_000,
    });
    res.redirect(302, url);
  }

  @Get('authentik/callback')
  @ApiOperation({ operationId: 'authAuthentikCallback' })
  async authentikCallback(@Req() req: Request, @Res() res: Response) {
    const cookieState = (req as Request & { cookies?: Record<string, string> }).cookies?.[OIDC_STATE_COOKIE];
    res.clearCookie(OIDC_STATE_COOKIE, { path: '/admin/auth/authentik' });
    try {
      const current = new URL(req.originalUrl, this.cfg.PUBLIC_URL);
      const { user, idToken } = await this.authentik.callback(current, cookieState, clientIp(req));
      const { token } = await this.sessions.create(user, { mfaPassed: true, ...meta(req), idTokenHint: idToken });
      this.sessions.setCookie(res, token, true);
      // SameSite=Strict cookies are not sent on the cross-site redirect chain; an HTML hop makes
      // the next navigation same-site so the UI immediately sees the session.
      res.status(200).type('html').send('<!doctype html><meta http-equiv="refresh" content="0;url=/ui/"><a href="/ui/">Continue</a>');
    } catch (e) {
      const msg = e instanceof GatewayError ? e.message : 'SSO login failed.';
      res.redirect(302, `/ui/login?error=${encodeURIComponent(msg)}`);
    }
  }
}
export { OkDto };

/** Self-service account security for the signed-in user (any role). */
@ApiTags('auth')
@ApiCookieAuth('session')
@UseGuards(AdminAuthGuard)
@Authenticated()
@Controller('admin/account')
export class AccountController {
  constructor(
    private readonly auth: AuthService,
    private readonly users: UsersService,
    private readonly sessions: SessionsService,
    private readonly passkeys: PasskeysService,
  ) {}

  @Post('password')
  @HttpCode(200)
  @ApiOperation({ operationId: 'accountChangePassword', summary: 'Change your password (local accounts). Your other sessions are signed out.' })
  @ApiBody({ type: ChangePasswordBody })
  @ApiOkResponse({ type: PasswordChangedDto })
  async changePassword(@Req() req: AdminRequest, @Body() body: ChangePasswordBody) {
    return this.auth.changePassword(await this.me(req), body?.currentPassword, body?.newPassword, req.sessionIdHash, meta(req));
  }

  @Get('sessions')
  @ApiOperation({ operationId: 'accountSessions', summary: 'Your active sessions' })
  @ApiOkResponse({ type: [AccountSessionDto] })
  async listSessions(@Req() req: AdminRequest) {
    const user = await this.me(req);
    return this.sessions.listForUser(user.id, req.sessionIdHash);
  }

  @Delete('sessions/:id')
  @HttpCode(204)
  @ApiOperation({ operationId: 'accountRevokeSession', summary: 'Sign out one of your sessions' })
  async revokeSession(@Req() req: AdminRequest, @Param('id') id: string) {
    const user = await this.me(req);
    await this.sessions.revokeForUser(user.id, id);
  }

  @Post('sessions/revoke-others')
  @HttpCode(200)
  @ApiOperation({ operationId: 'accountRevokeOtherSessions', summary: 'Sign out everywhere except here' })
  @ApiOkResponse({ type: RevokedDto })
  async revokeOthers(@Req() req: AdminRequest) {
    const user = await this.me(req);
    return { revoked: await this.sessions.revokeOthers(user.id, req.sessionIdHash) };
  }

  @Get('passkeys')
  @ApiOperation({ operationId: 'accountPasskeys' })
  @ApiOkResponse({ type: [PasskeyDto] })
  async listPasskeys(@Req() req: AdminRequest) {
    return this.passkeys.list((await this.me(req)).id);
  }

  @Post('passkeys/options')
  @HttpCode(200)
  @ApiOperation({ operationId: 'accountPasskeyOptions', summary: 'WebAuthn creation options for navigator.credentials.create().' })
  @ApiOkResponse({ schema: { type: 'object', additionalProperties: true } })
  async passkeyOptions(@Req() req: AdminRequest) {
    return this.passkeys.registrationOptions(await this.me(req), req);
  }

  @Post('passkeys')
  @ApiOperation({ operationId: 'accountAddPasskey', summary: 'Register the passkey created by the browser. It then works as a second factor.' })
  @ApiBody({ schema: { type: 'object', properties: { response: { type: 'object', additionalProperties: true }, name: { type: 'string' } }, required: ['response'] } })
  @ApiOkResponse({ type: PasskeyDto })
  async addPasskey(@Req() req: AdminRequest, @Body() body: { response?: unknown; name?: unknown }) {
    return this.passkeys.register(await this.me(req), body?.response, body?.name, req, clientIp(req));
  }

  @Delete('passkeys/:id')
  @HttpCode(204)
  @ApiOperation({ operationId: 'accountRemovePasskey' })
  async removePasskey(@Req() req: AdminRequest, @Param('id') id: string) {
    await this.passkeys.remove(await this.me(req), id, clientIp(req));
  }

  private async me(req: AdminRequest) {
    if (req.actor.type !== 'user' || !req.actor.id) throw new GatewayError('FORBIDDEN', 'Only signed-in users have an account.');
    return this.users.get(req.actor.id);
  }

  @Post('totp/setup')
  @HttpCode(200)
  @ApiOperation({ operationId: 'accountTotpSetup', summary: 'Start enabling 2FA: returns a new TOTP secret + QR code (inactive until confirmed).' })
  @ApiOkResponse({ type: TotpEnrollDto })
  async setup(@Req() req: AdminRequest): Promise<TotpEnrollDto> {
    return this.auth.accountTotpSetup(await this.me(req));
  }

  @Post('totp/confirm')
  @HttpCode(200)
  @ApiOperation({ operationId: 'accountTotpConfirm', summary: 'Confirm with a code from the app; 2FA is then required at every login.' })
  @ApiOkResponse({ type: UserDto })
  async confirm(@Req() req: AdminRequest, @Body() body: CodeBody) {
    const u = await this.auth.accountTotpConfirm(await this.me(req), body?.code, meta(req));
    return toUserView(await this.users.getFull(u.id));
  }

  @Post('totp/disable')
  @HttpCode(200)
  @ApiOperation({ operationId: 'accountTotpDisable', summary: 'Disable 2FA (requires the current password). Refused when TOTP_REQUIRED=true.' })
  @ApiOkResponse({ type: UserDto })
  async disable(@Req() req: AdminRequest, @Body() body: PasswordBody) {
    const u = await this.auth.accountTotpDisable(await this.me(req), body?.password, meta(req));
    return toUserView(await this.users.getFull(u.id));
  }
}
