import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Patch, Post, Query, Req, Res, UseGuards } from '@nestjs/common';
import {
  ApiAcceptedResponse,
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiBody,
  ApiCookieAuth,
  ApiOkResponse,
  ApiOperation,
  ApiProduces,
  ApiProperty,
  ApiPropertyOptional,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import type { Response } from 'express';
import { UsersService } from '../auth/users.service';
import { APP_CONFIG, AppConfig } from '../config/config';
import { GatewayError } from '../common/errors';
import { PrismaService } from '../common/prisma.service';
import { Prisma } from '../generated/prisma/client';
import { GatewayStateService } from '../gateway-state/gateway-state.service';
import { CreateKeyDto, KEY_MODES, UpdateKeyDto } from '../keys/keys.dto';
import { KeysService, toPolicyView } from '../keys/keys.service';
import { QuotaService } from '../policy/quota.service';
import { SendAcceptedDto } from '../send/send.dto';
import { SendService } from '../send/send.service';
import { AdminAuditService } from './admin-audit.service';
import { AdminAuthGuard, AdminRequest, RequireRole } from './admin-auth.guard';
import { AdminMessagesService, STATUSES } from './admin-messages.service';
import {
  AuditListDto,
  BulkResultDto,
  GatewayStateDto,
  InviteLinkDto,
  InviteResultDto,
  InviteUserDto,
  KeyCreatedDto,
  KeyDto,
  KeyListDto,
  KeyWithUsageDto,
  MessageActionDto,
  MessageDetailDto,
  MessageListDto,
  SettingsDto,
  StatsOverviewDto,
  SystemStateDto,
  TestSendDto,
  UpdateUserDto,
  UserDto,
  UserListDto,
} from './admin.dto';
import { qBool, qDate, qEnum, qInt, qList, qStr } from './query';
import { StatsService } from './stats.service';

/** Shared decorators for every admin controller. */
function AdminController(path: string) {
  const ctrl = Controller(path);
  const tags = ApiTags('admin');
  const bearer = ApiBearerAuth('admin');
  const cookie = ApiCookieAuth('session');
  const guard = UseGuards(AdminAuthGuard);
  return (target: object) => {
    for (const d of [ctrl, tags, bearer, cookie, guard]) (d as ClassDecorator)(target as never);
  };
}

const PAGE_QUERIES = [
  ApiQuery({ name: 'page', required: false, type: Number }),
  ApiQuery({ name: 'pageSize', required: false, type: Number }),
  ApiQuery({ name: 'order', required: false, enum: ['asc', 'desc'] }),
];
function Paged(): MethodDecorator {
  return (t, k, d) => {
    for (const q of PAGE_QUERIES) q(t, k, d);
  };
}

// ---------------------------------------------------------------- keys
@AdminController('admin/keys')
export class AdminKeysController {
  constructor(
    private readonly keys: KeysService,
    private readonly quota: QuotaService,
    private readonly send: SendService,
    private readonly audit: AdminAuditService,
  ) {}

  @Get()
  @RequireRole('viewer')
  @ApiOperation({ operationId: 'adminListKeys', summary: 'List API keys with current hour/day usage' })
  @Paged()
  @ApiQuery({ name: 'q', required: false })
  @ApiQuery({ name: 'mode', required: false, enum: KEY_MODES })
  @ApiQuery({ name: 'enabled', required: false, type: Boolean })
  @ApiQuery({ name: 'sort', required: false, enum: ['name', 'createdAt', 'lastUsedAt'] })
  @ApiOkResponse({ type: KeyListDto })
  async list(@Query() q: Record<string, string>) {
    const res = await this.keys.list({
      q: qStr(q.q),
      mode: qEnum(q.mode, KEY_MODES),
      enabled: qBool(q.enabled),
      page: qInt(q.page),
      pageSize: qInt(q.pageSize),
      sort: qEnum(q.sort, ['name', 'createdAt', 'lastUsedAt'] as const),
      order: qEnum(q.order, ['asc', 'desc'] as const),
    });
    const usage = await this.quota.usage(res.items.map((k) => k.id));
    return { ...res, items: res.items.map((k) => ({ ...k, usage: usage[k.id] ?? { hour: 0, day: 0 } })) };
  }

  @Post()
  @ApiOperation({ operationId: 'adminCreateKey', summary: 'Create an API key. The secret is returned ONCE.' })
  @ApiBody({ type: CreateKeyDto })
  @ApiCreatedResponse({ type: KeyCreatedDto })
  create(@Req() req: AdminRequest, @Body() body: unknown) {
    return this.keys.create(body, req.actor);
  }

  @Get(':id')
  @RequireRole('viewer')
  @ApiOperation({ operationId: 'adminGetKey' })
  @ApiOkResponse({ type: KeyWithUsageDto })
  async get(@Param('id') id: string) {
    const k = toPolicyView(await this.keys.getActive(id));
    const usage = (await this.quota.usage([id]))[id];
    return { ...k, usage };
  }

  @Patch(':id')
  @ApiOperation({ operationId: 'adminUpdateKey', summary: 'Update policy fields (mode, recipients, quotas, ...). Takes effect immediately.' })
  @ApiBody({ type: UpdateKeyDto })
  @ApiOkResponse({ type: KeyDto })
  update(@Req() req: AdminRequest, @Param('id') id: string, @Body() body: unknown) {
    return this.keys.update(id, body, req.actor);
  }

  @Post(':id/rotate')
  @HttpCode(200)
  @ApiOperation({ operationId: 'adminRotateKey', summary: 'Rotate the secret. The old secret stops working immediately; the new one is returned ONCE.' })
  @ApiOkResponse({ type: KeyCreatedDto })
  rotate(@Req() req: AdminRequest, @Param('id') id: string) {
    return this.keys.rotate(id, req.actor);
  }

  @Post(':id/enable')
  @HttpCode(200)
  @ApiOperation({ operationId: 'adminEnableKey' })
  @ApiOkResponse({ type: KeyDto })
  enable(@Req() req: AdminRequest, @Param('id') id: string) {
    return this.keys.setEnabled(id, true, req.actor);
  }

  @Post(':id/disable')
  @HttpCode(200)
  @ApiOperation({ operationId: 'adminDisableKey', summary: 'Kill switch for one key.' })
  @ApiOkResponse({ type: KeyDto })
  disable(@Req() req: AdminRequest, @Param('id') id: string) {
    return this.keys.setEnabled(id, false, req.actor);
  }

  @Delete(':id')
  @HttpCode(204)
  @ApiOperation({ operationId: 'adminDeleteKey' })
  async remove(@Req() req: AdminRequest, @Param('id') id: string) {
    await this.keys.remove(id, req.actor);
  }

  @Post(':id/test-send')
  @HttpCode(202)
  @ApiOperation({ operationId: 'adminTestSend', summary: 'Send a test email through the normal pipeline using this key (policy fully enforced).' })
  @ApiBody({ type: TestSendDto })
  @ApiAcceptedResponse({ type: SendAcceptedDto })
  async testSend(@Req() req: AdminRequest, @Param('id') id: string, @Body() body: TestSendDto) {
    const key = await this.keys.getActive(id);
    const subject = typeof body?.subject === 'string' && body.subject ? body.subject : `mail-gateway test (${key.name})`;
    const text =
      typeof body?.text === 'string' && body.text ? body.text : `Test message sent by ${req.actor.label} via the mail-gateway admin UI for key "${key.name}" (${key.mode}).`;
    try {
      const r = await this.send.submit({ apiKey: key, sourceIp: req.actor.ip, source: 'admin_test' }, { to: body?.to, subject, text });
      await this.audit.record(req.actor, { action: 'key.test_send', targetType: 'api_key', targetId: id, details: { name: key.name, messageId: r.id, status: r.status } });
      return { id: r.id, status: r.status };
    } catch (e) {
      if (e instanceof GatewayError) {
        await this.audit.record(req.actor, { action: 'key.test_send', outcome: 'failure', targetType: 'api_key', targetId: id, details: { name: key.name, code: e.code } });
      }
      throw e;
    }
  }
}

// ---------------------------------------------------------------- messages
class RejectBody {
  @ApiPropertyOptional({ description: 'Shown to the client as rejectReason.' })
  reason?: string;
}
class BulkBody {
  @ApiProperty({ type: [String], description: 'Message ids (max 500).' })
  ids!: string[];
  @ApiPropertyOptional({ description: 'Reject reason (reject only).' })
  reason?: string;
}

function validIds(body: BulkBody): string[] {
  if (!body || !Array.isArray(body.ids) || !body.ids.every((i) => typeof i === 'string')) {
    throw new GatewayError('VALIDATION_FAILED', 'Body must be { "ids": string[] }.');
  }
  return body.ids;
}

/** CSP for rendering untrusted email HTML: no scripts, no network except (optionally) images. */
export function previewCsp(remoteImages: boolean) {
  return [
    "default-src 'none'",
    "style-src 'unsafe-inline'",
    `img-src data: cid:${remoteImages ? ' https: http:' : ''}`,
    'font-src data:',
    "frame-ancestors 'self'",
    "base-uri 'none'",
    "form-action 'none'",
    'sandbox',
  ].join('; ');
}

/** Removes constructs that could navigate the frame without user interaction. Scripts are already blocked by CSP + sandbox. */
export function neutralizeHtml(html: string): string {
  return html.replace(/<meta\b[^>]*http-equiv\s*=\s*["']?refresh[^>]*>/gi, '').replace(/<base\b[^>]*>/gi, '');
}

@AdminController('admin/messages')
export class AdminMessagesController {
  constructor(private readonly messages: AdminMessagesService) {}

  @Get()
  @RequireRole('viewer')
  @ApiOperation({ operationId: 'adminListMessages', summary: 'Search messages (status, key, recipient, subject, date range)' })
  @Paged()
  @ApiQuery({ name: 'status', required: false, description: `Comma list of ${STATUSES.join(', ')}` })
  @ApiQuery({ name: 'keyId', required: false })
  @ApiQuery({ name: 'recipient', required: false })
  @ApiQuery({ name: 'subject', required: false })
  @ApiQuery({ name: 'from', required: false, description: 'ISO date' })
  @ApiQuery({ name: 'to', required: false, description: 'ISO date' })
  @ApiQuery({ name: 'sort', required: false, enum: ['createdAt', 'status', 'subject'] })
  @ApiOkResponse({ type: MessageListDto })
  list(@Query() q: Record<string, string>) {
    return this.messages.list({
      status: qList(q.status, STATUSES),
      keyId: qStr(q.keyId, 36),
      recipient: qStr(q.recipient, 320),
      subject: qStr(q.subject),
      from: qDate(q.from),
      to: qDate(q.to),
      page: qInt(q.page),
      pageSize: qInt(q.pageSize),
      sort: qEnum(q.sort, ['createdAt', 'status', 'subject'] as const),
      order: qEnum(q.order, ['asc', 'desc'] as const),
    });
  }

  @Get(':id')
  @RequireRole('viewer')
  @ApiOperation({ operationId: 'adminGetMessage', summary: 'Message detail. Bodies are null for viewers without canViewBodies.' })
  @ApiOkResponse({ type: MessageDetailDto })
  get(@Req() req: AdminRequest, @Param('id') id: string) {
    return this.messages.get(id, { includeBodies: !!req.actor.canViewBodies });
  }

  @Get(':id/preview')
  @RequireRole('viewer')
  @ApiOperation({ operationId: 'adminPreviewMessage', summary: 'HTML body for a sandboxed iframe (strict CSP; remote images blocked unless remoteImages=1).' })
  @ApiQuery({ name: 'remoteImages', required: false, enum: ['0', '1'] })
  @ApiProduces('text/html')
  async preview(@Req() req: AdminRequest, @Param('id') id: string, @Query('remoteImages') remote: string | undefined, @Res() res: Response) {
    if (!req.actor.canViewBodies) throw new GatewayError('FORBIDDEN', 'You are not allowed to view message bodies.');
    const html = await this.messages.htmlBody(id);
    res.setHeader('Content-Security-Policy', previewCsp(remote === '1'));
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.type('html').send(html ? neutralizeHtml(html) : '<!doctype html><p style="font-family:sans-serif;color:#888">No HTML body.</p>');
  }

  @Post('approve')
  @HttpCode(200)
  @ApiOperation({ operationId: 'adminBulkApprove' })
  @ApiOkResponse({ type: BulkResultDto })
  bulkApprove(@Req() req: AdminRequest, @Body() body: BulkBody) {
    return this.messages.bulk(validIds(body), (id) => this.messages.approve(id, req.actor));
  }

  @Post('reject')
  @HttpCode(200)
  @ApiOperation({ operationId: 'adminBulkReject' })
  @ApiOkResponse({ type: BulkResultDto })
  bulkReject(@Req() req: AdminRequest, @Body() body: BulkBody) {
    return this.messages.bulk(validIds(body), (id) => this.messages.reject(id, body?.reason, req.actor));
  }

  @Post(':id/approve')
  @HttpCode(200)
  @ApiOperation({ operationId: 'adminApproveMessage' })
  @ApiOkResponse({ type: MessageActionDto })
  approve(@Req() req: AdminRequest, @Param('id') id: string) {
    return this.messages.approve(id, req.actor);
  }

  @Post(':id/reject')
  @HttpCode(200)
  @ApiOperation({ operationId: 'adminRejectMessage' })
  @ApiOkResponse({ type: MessageActionDto })
  reject(@Req() req: AdminRequest, @Param('id') id: string, @Body() body: RejectBody) {
    return this.messages.reject(id, typeof body?.reason === 'string' ? body.reason : undefined, req.actor);
  }
}

// ---------------------------------------------------------------- gateway + stats
class PauseBody {
  @ApiPropertyOptional({ description: 'Why the gateway is paused (shown in the UI and audit log).' })
  reason?: string;
}

@AdminController('admin/gateway')
export class AdminGatewayController {
  constructor(private readonly gateway: GatewayStateService) {}

  @Get()
  @RequireRole('viewer')
  @ApiOperation({ operationId: 'adminGatewayState' })
  @ApiOkResponse({ type: GatewayStateDto })
  state() {
    return this.gateway.get();
  }

  @Post('pause')
  @HttpCode(200)
  @ApiOperation({ operationId: 'adminPauseGateway', summary: 'Stop accepting and delivering mail.' })
  @ApiOkResponse({ type: GatewayStateDto })
  pause(@Req() req: AdminRequest, @Body() body: PauseBody) {
    return this.gateway.pause(typeof body?.reason === 'string' && body.reason ? body.reason.slice(0, 500) : 'manual', req.actor);
  }

  @Post('resume')
  @HttpCode(200)
  @ApiOperation({ operationId: 'adminResumeGateway', summary: 'Resume and reset circuit breakers.' })
  @ApiOkResponse({ type: GatewayStateDto })
  resume(@Req() req: AdminRequest) {
    return this.gateway.resume(req.actor);
  }
}

@AdminController('admin/stats')
export class AdminStatsController {
  constructor(private readonly stats: StatsService) {}

  @Get('overview')
  @RequireRole('viewer')
  @ApiOperation({ operationId: 'adminStatsOverview', summary: 'Time series + breakdowns from the hourly roll-up' })
  @ApiQuery({ name: 'from', required: false })
  @ApiQuery({ name: 'to', required: false })
  @ApiQuery({ name: 'bucket', required: false, enum: ['hour', 'day'] })
  @ApiQuery({ name: 'keyId', required: false })
  @ApiOkResponse({ type: StatsOverviewDto })
  overview(@Query() q: Record<string, string>) {
    return this.stats.overview({ from: qDate(q.from), to: qDate(q.to), bucket: qEnum(q.bucket, ['hour', 'day'] as const), keyId: qStr(q.keyId, 36) });
  }

  @Get('system')
  @RequireRole('viewer')
  @ApiOperation({ operationId: 'adminSystemState', summary: 'Gateway state, breakers, queue depth, pending approvals, SMTP health' })
  @ApiOkResponse({ type: SystemStateDto })
  system() {
    return this.stats.system();
  }
}

// ---------------------------------------------------------------- users (admin only)
@AdminController('admin/users')
export class AdminUsersController {
  constructor(private readonly users: UsersService) {}

  @Get()
  @ApiOperation({ operationId: 'adminListUsers' })
  @ApiOkResponse({ type: UserListDto })
  list() {
    return this.users.list();
  }

  @Post()
  @ApiOperation({ operationId: 'adminInviteUser', summary: 'Create a local user and return a one-time invite link (shown once).' })
  @ApiBody({ type: InviteUserDto })
  @ApiCreatedResponse({ type: InviteResultDto })
  invite(@Req() req: AdminRequest, @Body() body: Record<string, unknown>) {
    return this.users.invite(body ?? {}, req.actor);
  }

  @Patch(':id')
  @ApiOperation({ operationId: 'adminUpdateUser', summary: 'Change role/body access, enable/disable.' })
  @ApiBody({ type: UpdateUserDto })
  @ApiOkResponse({ type: UserDto })
  update(@Req() req: AdminRequest, @Param('id') id: string, @Body() body: Record<string, unknown>) {
    return this.users.update(id, body ?? {}, req.actor);
  }

  @Post(':id/reset-2fa')
  @HttpCode(200)
  @ApiOperation({ operationId: 'adminResetUserTotp', summary: 'Force TOTP re-enrollment at next login (signs the user out).' })
  @ApiOkResponse({ type: UserDto })
  resetTotp(@Req() req: AdminRequest, @Param('id') id: string) {
    return this.users.resetTotp(id, req.actor);
  }

  @Post(':id/reset-access')
  @HttpCode(200)
  @ApiOperation({ operationId: 'adminResetUserAccess', summary: 'Clear password + TOTP and issue a new invite link.' })
  @ApiOkResponse({ type: InviteLinkDto })
  resetAccess(@Req() req: AdminRequest, @Param('id') id: string) {
    return this.users.resetAccess(id, req.actor);
  }

  @Delete(':id')
  @HttpCode(204)
  @ApiOperation({ operationId: 'adminDeleteUser' })
  async remove(@Req() req: AdminRequest, @Param('id') id: string) {
    await this.users.remove(id, req.actor);
  }
}

// ---------------------------------------------------------------- activity + settings
@AdminController('admin/audit')
export class AdminAuditController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  @RequireRole('viewer')
  @ApiOperation({ operationId: 'adminListAudit', summary: 'Admin activity log' })
  @Paged()
  @ApiQuery({ name: 'action', required: false })
  @ApiQuery({ name: 'actor', required: false })
  @ApiQuery({ name: 'actorType', required: false, enum: ['user', 'token', 'cli', 'system'] })
  @ApiQuery({ name: 'outcome', required: false, enum: ['success', 'failure'] })
  @ApiQuery({ name: 'from', required: false })
  @ApiQuery({ name: 'to', required: false })
  @ApiOkResponse({ type: AuditListDto })
  async list(@Query() q: Record<string, string>) {
    const page = Math.max(1, qInt(q.page) ?? 1);
    const pageSize = Math.min(200, Math.max(1, qInt(q.pageSize) ?? 50));
    const from = qDate(q.from);
    const to = qDate(q.to);
    const where: Prisma.AdminAuditWhereInput = {
      ...(q.action ? { action: { startsWith: qStr(q.action, 100) } } : {}),
      ...(q.actor ? { actorLabel: { contains: qStr(q.actor, 254), mode: 'insensitive' } } : {}),
      ...(q.actorType ? { actorType: qEnum(q.actorType, ['user', 'token', 'cli', 'system'] as const) } : {}),
      ...(q.outcome ? { outcome: qEnum(q.outcome, ['success', 'failure'] as const) } : {}),
      ...(from || to ? { at: { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) } } : {}),
    };
    const order = qEnum(q.order, ['asc', 'desc'] as const) ?? 'desc';
    const [items, total, actions] = await Promise.all([
      this.prisma.adminAudit.findMany({ where, orderBy: { at: order }, skip: (page - 1) * pageSize, take: pageSize }),
      this.prisma.adminAudit.count({ where }),
      this.prisma.adminAudit.findMany({ distinct: ['action'], select: { action: true }, orderBy: { action: 'asc' } }),
    ]);
    return { items, total, page, pageSize, actions: actions.map((a) => a.action) };
  }
}

@AdminController('admin/settings')
export class AdminSettingsController {
  constructor(@Inject(APP_CONFIG) private readonly cfg: AppConfig) {}

  @Get()
  @RequireRole('viewer')
  @ApiOperation({ operationId: 'adminSettings', summary: 'Effective configuration (read-only, never secrets)' })
  @ApiOkResponse({ type: SettingsDto })
  get(): SettingsDto {
    const c = this.cfg;
    return {
      liveProvider: c.LIVE_PROVIDER,
      smtp: { enabled: c.smtpEnabled, host: c.SMTP_HOST ?? null, port: c.SMTP_PORT, secure: c.SMTP_SECURE, requireTls: c.SMTP_REQUIRE_TLS, authConfigured: !!c.SMTP_USER },
      resend: { enabled: c.RESEND_ENABLED, webhookConfigured: !!c.RESEND_WEBHOOK_SECRET },
      mailpitSmtp: `${c.MAILPIT_SMTP_HOST}:${c.MAILPIT_SMTP_PORT}`,
      mailpitUiUrl: c.MAILPIT_UI_URL ?? null,
      bodyRetentionDays: c.AUDIT_BODY_RETENTION_DAYS,
      recordRetentionDays: c.AUDIT_RECORD_RETENTION_DAYS,
      retentionCron: c.RETENTION_CRON,
      globalRateMax: c.GLOBAL_RATE_MAX,
      globalRateDurationMs: c.GLOBAL_RATE_DURATION_MS,
      globalAcceptPerHour: c.GLOBAL_ACCEPT_PER_HOUR,
      dedupWindowSeconds: c.DEDUP_WINDOW_SECONDS,
      idempotencyTtlSeconds: c.IDEMPOTENCY_TTL_SECONDS,
      deliveryMaxAttempts: c.DELIVERY_MAX_ATTEMPTS,
      breakerConsecutiveFailures: c.BREAKER_CONSECUTIVE_FAILURES,
      breakerFailureRate: c.BREAKER_FAILURE_RATE,
      breakerWindowSeconds: c.BREAKER_WINDOW_SECONDS,
      maxRequestBytes: c.MAX_REQUEST_BYTES,
      trustProxy: c.TRUST_PROXY,
      localLogin: c.LOCAL_LOGIN_ENABLED,
      adminTokenEnabled: c.ADMIN_TOKEN_ENABLED && !!c.ADMIN_TOKEN,
      sessionTtlHours: c.SESSION_TTL_HOURS,
      sessionIdleMinutes: c.SESSION_IDLE_MINUTES,
      authentik: {
        enabled: c.AUTHENTIK_ENABLED,
        issuer: c.AUTHENTIK_ISSUER ?? null,
        adminGroup: c.AUTHENTIK_ADMIN_GROUP,
        viewerGroup: c.AUTHENTIK_VIEWER_GROUP,
        bodiesGroup: c.AUTHENTIK_BODIES_GROUP,
        scopes: c.AUTHENTIK_SCOPES,
      },
    };
  }
}
