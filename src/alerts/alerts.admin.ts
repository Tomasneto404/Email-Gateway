// Authored by Tomás Neto (TN 2026)
import { Body, Controller, Delete, Get, HttpCode, Injectable, Param, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';
import { ApiAcceptedResponse, ApiBearerAuth, ApiBody, ApiCookieAuth, ApiCreatedResponse, ApiOkResponse, ApiOperation, ApiProperty, ApiPropertyOptional, ApiQuery, ApiTags } from '@nestjs/swagger';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsBoolean, IsIn, IsOptional, IsString, Matches, MaxLength, MinLength } from 'class-validator';
import { randomBytes } from 'node:crypto';
import { Actor, AdminAuditService } from '../admin/admin-audit.service';
import { AdminAuthGuard, AdminRequest, RequirePermission } from '../admin/admin-auth.guard';
import { qInt } from '../admin/query';
import { SecretBox } from '../auth/crypto';
import { GatewayError } from '../common/errors';
import { PrismaService } from '../common/prisma.service';
import { isPlainEmail } from '../common/validators';
import { AlertChannel } from '../generated/prisma/client';
import { validateDto } from '../keys/keys.service';
import { ALERT_TYPES, ALERT_TYPE_IDS, AlertsService } from './alerts.service';

const CHANNEL_TYPES = ['webhook', 'slack', 'email'] as const;
const EVENT_CHOICES = ['*', ...ALERT_TYPE_IDS];

class ChannelFieldsDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @MinLength(2) @MaxLength(64) @Matches(/^[\w .-]+$/, { message: 'name may only contain letters, digits, spaces, ".", "_" and "-"' })
  name?: string;

  @ApiPropertyOptional({ description: 'webhook / slack: the URL (https recommended). email: comma-separated addresses.' })
  @IsOptional() @IsString() @MinLength(3) @MaxLength(2000)
  target?: string;

  @ApiPropertyOptional({ type: [String], description: 'Alert types delivered to this channel; ["*"] = all.' })
  @IsOptional() @IsArray() @ArrayMinSize(1) @ArrayMaxSize(20) @IsIn(EVENT_CHOICES, { each: true })
  events?: string[];

  @ApiPropertyOptional() @IsOptional() @IsBoolean()
  enabled?: boolean;
}

export class CreateAlertChannelDto extends ChannelFieldsDto {
  @ApiProperty({ enum: CHANNEL_TYPES }) @IsIn(CHANNEL_TYPES)
  type!: (typeof CHANNEL_TYPES)[number];
}
export class UpdateAlertChannelDto extends ChannelFieldsDto {}

export class AlertChannelDto {
  @ApiProperty() id!: string;
  @ApiProperty() name!: string;
  @ApiProperty({ enum: CHANNEL_TYPES }) type!: string;
  @ApiProperty({ description: 'Target with the secret parts hidden (URL host only, email addresses as is)' }) targetPreview!: string;
  @ApiProperty() signed!: boolean;
  @ApiProperty({ type: [String] }) events!: string[];
  @ApiProperty() enabled!: boolean;
  @ApiProperty({ type: String, nullable: true }) lastDeliveredAt!: string | null;
  @ApiProperty({ type: String, nullable: true }) lastError!: string | null;
  @ApiProperty() createdAt!: string;
}
export class AlertChannelCreatedDto {
  @ApiProperty({ type: AlertChannelDto }) channel!: AlertChannelDto;
  @ApiPropertyOptional({ description: 'Webhook signing secret, shown ONCE. Verify X-Mail-Gateway-Signature = sha256=HMAC(secret, "<timestamp>.<body>").' })
  signingSecret?: string;
}
export class AlertChannelListDto {
  @ApiProperty({ type: [AlertChannelDto] }) items!: AlertChannelDto[];
}
export class AlertTypeDto {
  @ApiProperty() type!: string;
  @ApiProperty({ enum: ['info', 'warning', 'critical'] }) severity!: string;
  @ApiProperty() label!: string;
}
export class AlertEventDto {
  @ApiProperty() id!: string;
  @ApiProperty() at!: string;
  @ApiProperty() type!: string;
  @ApiProperty({ enum: ['info', 'warning', 'critical'] }) severity!: string;
  @ApiProperty() title!: string;
  @ApiProperty({ type: 'object', additionalProperties: true, nullable: true }) detail!: Record<string, unknown> | null;
  @ApiProperty({ type: [String] }) deliveredTo!: string[];
  @ApiProperty({ type: [String] }) failedTo!: string[];
}
export class AlertEventListDto {
  @ApiProperty({ type: [AlertEventDto] }) items!: AlertEventDto[];
  @ApiProperty() total!: number;
  @ApiProperty() page!: number;
  @ApiProperty() pageSize!: number;
}
export class AlertTestDto {
  @ApiProperty() eventId!: string;
}

function validTarget(type: string, target: string): string {
  const t = target.trim();
  if (type === 'email') {
    const list = t.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
    if (!list.length || list.length > 20 || !list.every(isPlainEmail)) throw new GatewayError('VALIDATION_FAILED', 'target must be 1-20 comma-separated email addresses.');
    return list.join(',');
  }
  let u: URL;
  try {
    u = new URL(t);
  } catch {
    throw new GatewayError('VALIDATION_FAILED', 'target must be a URL.');
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new GatewayError('VALIDATION_FAILED', 'target must be an http(s) URL.');
  if (u.username || u.password) throw new GatewayError('VALIDATION_FAILED', 'Put credentials in the signing secret, not in the URL.');
  return u.toString();
}

function preview(type: string, target: string): string {
  if (type === 'email') return target;
  try {
    const u = new URL(target);
    return `${u.protocol}//${u.host}/…`;
  } catch {
    return '…';
  }
}

@Injectable()
export class AlertChannelsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly box: SecretBox,
    private readonly audit: AdminAuditService,
    private readonly alerts: AlertsService,
  ) {}

  private requireBox() {
    if (!this.box.available) throw new GatewayError('INVALID_STATE', 'APP_ENCRYPTION_KEY is required to store alert channel targets.');
  }

  view(c: AlertChannel): AlertChannelDto {
    let target = '';
    try {
      target = this.box.open(c.targetEnc);
    } catch {
      /* key changed: shown as unknown */
    }
    return {
      id: c.id,
      name: c.name,
      type: c.type,
      targetPreview: preview(c.type, target),
      signed: !!c.secretEnc,
      events: c.events,
      enabled: c.enabled,
      lastDeliveredAt: c.lastDeliveredAt?.toISOString() ?? null,
      lastError: c.lastError,
      createdAt: c.createdAt.toISOString(),
    };
  }

  async list() {
    const items = await this.prisma.alertChannel.findMany({ orderBy: { name: 'asc' } });
    return { items: items.map((c) => this.view(c)) };
  }

  async get(id: string) {
    const c = /^[0-9a-f-]{36}$/i.test(id) ? await this.prisma.alertChannel.findUnique({ where: { id } }) : null;
    if (!c) throw new GatewayError('NOT_FOUND', `Alert channel ${id} not found.`);
    return c;
  }

  async create(body: unknown, actor: Actor): Promise<AlertChannelCreatedDto> {
    this.requireBox();
    const dto = await validateDto(CreateAlertChannelDto, body);
    if (!dto.name || !dto.target) throw new GatewayError('VALIDATION_FAILED', 'name and target are required.');
    if (await this.prisma.alertChannel.findUnique({ where: { name: dto.name } })) throw new GatewayError('CONFLICT', `An alert channel named "${dto.name}" already exists.`);
    const secret = dto.type === 'webhook' ? randomBytes(32).toString('base64url') : undefined;
    const c = await this.prisma.alertChannel.create({
      data: {
        name: dto.name,
        type: dto.type,
        targetEnc: this.box.seal(validTarget(dto.type, dto.target)),
        secretEnc: secret ? this.box.seal(secret) : null,
        events: dto.events ?? ['*'],
        enabled: dto.enabled ?? true,
      },
    });
    await this.audit.record(actor, { action: 'alert_channel.create', targetType: 'alert_channel', targetId: c.id, details: { name: c.name, type: c.type, events: c.events } });
    return { channel: this.view(c), ...(secret ? { signingSecret: secret } : {}) };
  }

  async update(id: string, body: unknown, actor: Actor) {
    this.requireBox();
    const dto = await validateDto(UpdateAlertChannelDto, body);
    const before = await this.get(id);
    if (dto.name && dto.name !== before.name && (await this.prisma.alertChannel.findUnique({ where: { name: dto.name } }))) {
      throw new GatewayError('CONFLICT', `An alert channel named "${dto.name}" already exists.`);
    }
    const c = await this.prisma.alertChannel.update({
      where: { id },
      data: {
        ...(dto.name ? { name: dto.name } : {}),
        ...(dto.target ? { targetEnc: this.box.seal(validTarget(before.type, dto.target)) } : {}),
        ...(dto.events ? { events: dto.events } : {}),
        ...(dto.enabled !== undefined ? { enabled: dto.enabled } : {}),
      },
    });
    await this.audit.record(actor, { action: 'alert_channel.update', targetType: 'alert_channel', targetId: id, details: { name: c.name, changed: Object.keys(dto) } });
    return this.view(c);
  }

  async remove(id: string, actor: Actor) {
    const c = await this.get(id);
    await this.prisma.alertChannel.delete({ where: { id } });
    await this.audit.record(actor, { action: 'alert_channel.delete', targetType: 'alert_channel', targetId: id, details: { name: c.name } });
  }

  async test(id: string, actor: Actor) {
    const c = await this.get(id);
    const eventId = await this.alerts.raise('test', `Test alert for channel "${c.name}"`, { channelId: c.id, channel: c.name, by: actor.label });
    await this.audit.record(actor, { action: 'alert_channel.test', targetType: 'alert_channel', targetId: id, details: { name: c.name } });
    return { eventId: eventId! };
  }

  async events(page = 1, pageSize = 50) {
    const p = Math.max(1, page);
    const size = Math.min(200, Math.max(1, pageSize));
    const [items, total] = await Promise.all([
      this.prisma.alertEvent.findMany({ orderBy: { at: 'desc' }, skip: (p - 1) * size, take: size }),
      this.prisma.alertEvent.count(),
    ]);
    return {
      items: items.map((e) => ({ ...e, at: e.at.toISOString(), detail: (e.detail ?? null) as Record<string, unknown> | null })),
      total,
      page: p,
      pageSize: size,
    };
  }
}

@ApiTags('admin')
@ApiBearerAuth('admin')
@ApiCookieAuth('session')
@UseGuards(AdminAuthGuard)
@Controller('admin/alerts')
export class AdminAlertsController {
  constructor(private readonly channels: AlertChannelsService) {}

  @Get('types')
  @RequirePermission('alerts:read')
  @ApiOperation({ operationId: 'adminAlertTypes', summary: 'Alert types a channel can subscribe to' })
  @ApiOkResponse({ type: [AlertTypeDto] })
  types() {
    return ALERT_TYPES;
  }

  @Get('channels')
  @RequirePermission('alerts:read')
  @ApiOperation({ operationId: 'adminListAlertChannels' })
  @ApiOkResponse({ type: AlertChannelListDto })
  list() {
    return this.channels.list();
  }

  @Post('channels')
  @RequirePermission('alerts:manage')
  @ApiOperation({ operationId: 'adminCreateAlertChannel', summary: 'Webhook (HMAC-signed), Slack incoming webhook or email. A webhook signing secret is returned ONCE.' })
  @ApiBody({ type: CreateAlertChannelDto })
  @ApiCreatedResponse({ type: AlertChannelCreatedDto })
  create(@Req() req: AdminRequest, @Body() body: unknown) {
    return this.channels.create(body, req.actor);
  }

  @Patch('channels/:id')
  @RequirePermission('alerts:manage')
  @ApiOperation({ operationId: 'adminUpdateAlertChannel' })
  @ApiBody({ type: UpdateAlertChannelDto })
  @ApiOkResponse({ type: AlertChannelDto })
  update(@Req() req: AdminRequest, @Param('id') id: string, @Body() body: unknown) {
    return this.channels.update(id, body, req.actor);
  }

  @Delete('channels/:id')
  @HttpCode(204)
  @RequirePermission('alerts:manage')
  @ApiOperation({ operationId: 'adminDeleteAlertChannel' })
  async remove(@Req() req: AdminRequest, @Param('id') id: string) {
    await this.channels.remove(id, req.actor);
  }

  @Post('channels/:id/test')
  @HttpCode(202)
  @RequirePermission('alerts:manage')
  @ApiOperation({ operationId: 'adminTestAlertChannel', summary: 'Send a test alert to this channel only (delivered by the worker).' })
  @ApiAcceptedResponse({ type: AlertTestDto })
  test(@Req() req: AdminRequest, @Param('id') id: string) {
    return this.channels.test(id, req.actor);
  }

  @Get('events')
  @RequirePermission('alerts:read')
  @ApiOperation({ operationId: 'adminListAlertEvents', summary: 'Alert history, newest first' })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'pageSize', required: false, type: Number })
  @ApiOkResponse({ type: AlertEventListDto })
  events(@Query() q: Record<string, string>) {
    return this.channels.events(qInt(q.page), qInt(q.pageSize));
  }
}
