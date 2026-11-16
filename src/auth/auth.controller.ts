import { Body, Controller, Get, HttpCode, Inject, Param, Post, Req, Res } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { AdminAuditService } from '../admin/admin-audit.service';
import { sameOrigin } from '../admin/admin-auth.guard';
import { APP_CONFIG, AppConfig } from '../config/config';
import { GatewayError } from '../common/errors';
import { clientIp } from '../common/http';
import { AuthService } from './auth.service';
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
}
class LoginResultDto {
  @ApiProperty({ enum: ['totp_enroll', 'totp_verify'] }) next!: 'totp_enroll' | 'totp_verify';
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
    return { localLogin: this.cfg.LOCAL_LOGIN_ENABLED, authentik: this.cfg.AUTHENTIK_ENABLED };
  }

  @Post('login')
  @HttpCode(200)
  @ApiOperation({ operationId: 'authLogin', summary: 'Step 1: email + password. Sets a short-lived pre-MFA session cookie.' })
  @ApiOkResponse({ type: LoginResultDto })
  async login(@Req() req: Request, @Res({ passthrough: true }) res: Response, @Body() body: LoginBody): Promise<LoginResultDto> {
    this.requireOrigin(req);
    const r = await this.auth.login(body?.email, body?.password, meta(req));
    this.sessions.setCookie(res, r.token, false);
    return { next: r.next };
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
    const fresh = await this.users.get(user.id);
    return { user: toUserView(fresh), csrfToken: full.session.csrfToken };
  }

  @Get('session')
  @ApiOperation({ operationId: 'authSession', summary: 'Current user + CSRF token. 401 when not logged in.' })
  @ApiOkResponse({ type: SessionDto })
  async session(@Req() req: Request): Promise<SessionDto> {
    const r = await this.sessions.resolve(this.sessions.readToken(req));
    if (!r) throw new GatewayError('UNAUTHORIZED', 'Not logged in.');
    if (!r.session.mfaPassed) throw new GatewayError('MFA_REQUIRED', 'Complete two-factor authentication.', { next: r.user.totpEnrolled ? 'totp_verify' : 'totp_enroll' });
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
