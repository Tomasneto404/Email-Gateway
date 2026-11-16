import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * Response shapes of the admin API. They exist for the OpenAPI document, from which the
 * admin UI's client/types are generated (so the UI cannot drift from the backend).
 */

const MODES = ['sandbox', 'live', 'approval'];
const STATUSES = ['queued', 'pending_approval', 'sent', 'failed', 'rejected', 'captured'];

export class KeyUsageDto {
  @ApiProperty() hour!: number;
  @ApiProperty() day!: number;
}

export class KeyDto {
  @ApiProperty() id!: string;
  @ApiProperty() name!: string;
  @ApiProperty() description!: string;
  @ApiProperty() keyPrefix!: string;
  @ApiProperty({ enum: MODES }) mode!: 'sandbox' | 'live' | 'approval';
  @ApiProperty() enabled!: boolean;
  @ApiProperty() fromAddress!: string;
  @ApiProperty({ type: String, nullable: true }) fromName!: string | null;
  @ApiProperty() allowReplyTo!: boolean;
  @ApiProperty({ type: [String] }) allowedRecipients!: string[];
  @ApiProperty() maxRecipientsPerMessage!: number;
  @ApiProperty() maxMessageBytes!: number;
  @ApiProperty() quotaPerHour!: number;
  @ApiProperty() quotaPerDay!: number;
  @ApiProperty() attachmentsAllowed!: boolean;
  @ApiProperty() maxAttachmentBytes!: number;
  @ApiProperty({ enum: ['smtp', 'resend'], nullable: true, type: String }) liveProvider!: 'smtp' | 'resend' | null;
  @ApiProperty() prefixStale!: boolean;
  @ApiProperty({ type: String, nullable: true }) lastUsedAt!: string | null;
  @ApiProperty({ type: String, nullable: true }) rotatedAt!: string | null;
  @ApiProperty() createdAt!: string;
  @ApiProperty() updatedAt!: string;
}

export class KeyWithUsageDto extends KeyDto {
  @ApiProperty({ type: KeyUsageDto }) usage!: KeyUsageDto;
}

export class KeyListDto {
  @ApiProperty({ type: [KeyWithUsageDto] }) items!: KeyWithUsageDto[];
  @ApiProperty() total!: number;
  @ApiProperty() page!: number;
  @ApiProperty() pageSize!: number;
}

export class KeyCreatedDto {
  @ApiProperty({ type: KeyDto }) key!: KeyDto;
  @ApiProperty({ description: 'The API key secret. Shown ONCE; only its hash is stored.' }) secret!: string;
}

export class TestSendDto {
  @ApiProperty({ description: 'Recipient (must be allowed by the key policy)' }) to!: string;
  @ApiPropertyOptional() subject?: string;
  @ApiPropertyOptional() text?: string;
}

export class KeyRefDto {
  @ApiProperty() id!: string;
  @ApiProperty() name!: string;
}

export class MessageListItemDto {
  @ApiProperty() id!: string;
  @ApiProperty({ enum: STATUSES }) status!: string;
  @ApiProperty({ enum: MODES }) deliveryMode!: string;
  @ApiProperty({ type: String, nullable: true, enum: ['smtp', 'resend', 'mailpit'] }) provider!: string | null;
  @ApiProperty({ enum: ['api', 'admin_test'] }) source!: string;
  @ApiProperty({ type: [String] }) to!: string[];
  @ApiProperty({ type: [String] }) cc!: string[];
  @ApiProperty({ type: [String] }) bcc!: string[];
  @ApiProperty() subject!: string;
  @ApiProperty({ type: String, nullable: true }) rejectCode!: string | null;
  @ApiProperty() attempts!: number;
  @ApiProperty({ type: String, nullable: true }) deliveryOutcome!: string | null;
  @ApiProperty() createdAt!: string;
  @ApiProperty({ type: String, nullable: true }) sentAt!: string | null;
  @ApiProperty({ type: KeyRefDto }) apiKey!: KeyRefDto;
}

export class MessageListDto {
  @ApiProperty({ type: [MessageListItemDto] }) items!: MessageListItemDto[];
  @ApiProperty() total!: number;
  @ApiProperty() page!: number;
  @ApiProperty() pageSize!: number;
}

export class MessageEventDto {
  @ApiProperty() id!: string;
  @ApiProperty({ enum: ['status', 'attempt', 'provider_event', 'admin'] }) type!: string;
  @ApiProperty({ type: String, nullable: true, enum: STATUSES }) fromStatus!: string | null;
  @ApiProperty({ type: String, nullable: true, enum: STATUSES }) toStatus!: string | null;
  @ApiProperty({ type: 'object', additionalProperties: true, nullable: true }) detail!: Record<string, unknown> | null;
  @ApiProperty() at!: string;
}

export class AttachmentMetaDto {
  @ApiProperty() id!: string;
  @ApiProperty() filename!: string;
  @ApiProperty() contentType!: string;
  @ApiProperty() sizeBytes!: number;
}

export class MessageKeyRefDto extends KeyRefDto {
  @ApiProperty({ enum: MODES }) mode!: string;
}

export class MessageDetailDto {
  @ApiProperty() id!: string;
  @ApiProperty({ enum: STATUSES }) status!: string;
  @ApiProperty({ enum: MODES }) deliveryMode!: string;
  @ApiProperty({ type: String, nullable: true }) provider!: string | null;
  @ApiProperty() source!: string;
  @ApiProperty({ type: String, nullable: true }) rejectCode!: string | null;
  @ApiProperty({ type: String, nullable: true }) rejectReason!: string | null;
  @ApiProperty() fromAddress!: string;
  @ApiProperty({ type: String, nullable: true }) fromName!: string | null;
  @ApiProperty({ type: [String] }) to!: string[];
  @ApiProperty({ type: [String] }) cc!: string[];
  @ApiProperty({ type: [String] }) bcc!: string[];
  @ApiProperty({ type: String, nullable: true }) replyTo!: string | null;
  @ApiProperty() subject!: string;
  @ApiProperty() bodyHash!: string;
  @ApiProperty({ type: 'object', additionalProperties: true, nullable: true }) metadata!: Record<string, unknown> | null;
  @ApiProperty({ type: String, nullable: true }) sourceIp!: string | null;
  @ApiProperty() sizeBytes!: number;
  @ApiProperty() attempts!: number;
  @ApiProperty({ type: String, nullable: true }) lastError!: string | null;
  @ApiProperty({ type: String, nullable: true }) providerResponse!: string | null;
  @ApiProperty({ type: String, nullable: true }) providerMessageId!: string | null;
  @ApiProperty({ type: String, nullable: true }) deliveryOutcome!: string | null;
  @ApiProperty({ type: String, nullable: true }) bodyPurgedAt!: string | null;
  @ApiProperty() createdAt!: string;
  @ApiProperty() updatedAt!: string;
  @ApiProperty({ type: String, nullable: true }) sentAt!: string | null;
  @ApiProperty({ type: MessageKeyRefDto }) apiKey!: MessageKeyRefDto;
  @ApiProperty({ type: [AttachmentMetaDto] }) attachments!: AttachmentMetaDto[];
  @ApiProperty({ type: [MessageEventDto] }) events!: MessageEventDto[];
  @ApiProperty({ type: 'object', additionalProperties: { type: 'string' } }) headers!: Record<string, string>;
  @ApiProperty({ description: 'false when the caller may not see bodies (viewer without canViewBodies)' }) bodiesVisible!: boolean;
  @ApiProperty({ type: String, nullable: true }) textBody!: string | null;
  @ApiProperty({ type: String, nullable: true }) htmlBody!: string | null;
  @ApiProperty() hasHtml!: boolean;
  @ApiProperty() hasText!: boolean;
}

export class MessageActionDto {
  @ApiProperty() id!: string;
  @ApiProperty({ enum: STATUSES }) status!: string;
}

export class BulkItemDto {
  @ApiProperty() id!: string;
  @ApiProperty() ok!: boolean;
  @ApiPropertyOptional() error?: string;
}
export class BulkResultDto {
  @ApiProperty({ type: [BulkItemDto] }) results!: BulkItemDto[];
}

export class GatewayStateDto {
  @ApiProperty() paused!: boolean;
  @ApiProperty({ type: String, nullable: true }) reason!: string | null;
  @ApiProperty({ type: String, nullable: true }) pausedBy!: string | null;
  @ApiProperty({ type: String, nullable: true }) pausedAt!: string | null;
}

export class SeriesPointDto {
  @ApiProperty({ description: 'Bucket start (ISO)' }) t!: string;
  @ApiProperty() accepted!: number;
  @ApiProperty() sent!: number;
  @ApiProperty() captured!: number;
  @ApiProperty() failed!: number;
  @ApiProperty() rejected!: number;
}
export class ReasonCountDto {
  @ApiProperty() reason!: string;
  @ApiProperty() count!: number;
}
export class TopKeyDto {
  @ApiProperty() keyId!: string;
  @ApiProperty() name!: string;
  @ApiProperty() count!: number;
}
export class OutcomeCountDto {
  @ApiProperty({ enum: ['delivered', 'delayed', 'bounced', 'complained'] }) outcome!: string;
  @ApiProperty() count!: number;
}
export class TotalsDto {
  @ApiProperty() accepted!: number;
  @ApiProperty() sent!: number;
  @ApiProperty() captured!: number;
  @ApiProperty() failed!: number;
  @ApiProperty() rejected!: number;
}
export class StatsOverviewDto {
  @ApiProperty({ enum: ['hour', 'day'] }) bucket!: 'hour' | 'day';
  @ApiProperty() from!: string;
  @ApiProperty() to!: string;
  @ApiProperty({ type: TotalsDto }) totals!: TotalsDto;
  @ApiProperty({ type: [SeriesPointDto] }) series!: SeriesPointDto[];
  @ApiProperty({ type: [ReasonCountDto] }) rejectionsByReason!: ReasonCountDto[];
  @ApiProperty({ type: [TopKeyDto] }) topKeys!: TopKeyDto[];
  @ApiProperty({ type: [OutcomeCountDto] }) outcomes!: OutcomeCountDto[];
}

export class CheckDto {
  @ApiProperty({ enum: ['up', 'down', 'skipped'] }) status!: 'up' | 'down' | 'skipped';
  @ApiPropertyOptional() latencyMs?: number;
  @ApiPropertyOptional() error?: string;
}
export class BreakerDto {
  @ApiProperty({ enum: ['smtp', 'resend'] }) provider!: string;
  @ApiProperty() enabled!: boolean;
  @ApiProperty({ enum: ['open', 'closed'] }) state!: 'open' | 'closed';
}
export class QueueDepthDto {
  @ApiProperty() waiting!: number;
  @ApiProperty() active!: number;
  @ApiProperty() delayed!: number;
  @ApiProperty() failed!: number;
  @ApiProperty() paused!: number;
  @ApiProperty() prioritized!: number;
}
export class SystemStateDto {
  @ApiProperty({ type: GatewayStateDto }) gateway!: GatewayStateDto;
  @ApiProperty({ type: [BreakerDto] }) breakers!: BreakerDto[];
  @ApiProperty({ type: QueueDepthDto }) queue!: QueueDepthDto;
  @ApiProperty() pendingApprovals!: number;
  @ApiProperty({ type: CheckDto }) smtpHealth!: CheckDto;
}

export class UserDto {
  @ApiProperty() id!: string;
  @ApiProperty() email!: string;
  @ApiProperty() name!: string;
  @ApiProperty({ enum: ['admin', 'viewer'] }) role!: 'admin' | 'viewer';
  @ApiProperty() canViewBodies!: boolean;
  @ApiProperty({ enum: ['local', 'authentik'] }) authSource!: string;
  @ApiProperty() totpEnrolled!: boolean;
  @ApiProperty() disabled!: boolean;
  @ApiProperty() locked!: boolean;
  @ApiProperty() pendingInvite!: boolean;
  @ApiProperty({ type: String, nullable: true }) lastLoginAt!: string | null;
  @ApiProperty() createdAt!: string;
}
export class UserListDto {
  @ApiProperty({ type: [UserDto] }) items!: UserDto[];
  @ApiProperty() total!: number;
}
export class InviteUserDto {
  @ApiProperty() email!: string;
  @ApiPropertyOptional() name?: string;
  @ApiProperty({ enum: ['admin', 'viewer'] }) role!: 'admin' | 'viewer';
  @ApiPropertyOptional() canViewBodies?: boolean;
}
export class UpdateUserDto {
  @ApiPropertyOptional() name?: string;
  @ApiPropertyOptional({ enum: ['admin', 'viewer'] }) role?: 'admin' | 'viewer';
  @ApiPropertyOptional() canViewBodies?: boolean;
  @ApiPropertyOptional() disabled?: boolean;
}
export class InviteLinkDto {
  @ApiProperty({ description: 'Relative URL of the one-time invite page (shown once)' }) invitePath!: string;
  @ApiProperty() expiresInHours!: number;
}
export class InviteResultDto extends InviteLinkDto {
  @ApiProperty({ type: UserDto }) user!: UserDto;
}

export class AuditEntryDto {
  @ApiProperty() id!: string;
  @ApiProperty() at!: string;
  @ApiProperty({ enum: ['user', 'token', 'cli', 'system'] }) actorType!: string;
  @ApiProperty({ type: String, nullable: true }) actorId!: string | null;
  @ApiProperty() actorLabel!: string;
  @ApiProperty() action!: string;
  @ApiProperty({ type: String, nullable: true }) targetType!: string | null;
  @ApiProperty({ type: String, nullable: true }) targetId!: string | null;
  @ApiProperty({ type: 'object', additionalProperties: true, nullable: true }) details!: Record<string, unknown> | null;
  @ApiProperty({ type: String, nullable: true }) ip!: string | null;
  @ApiProperty({ enum: ['success', 'failure'] }) outcome!: string;
}
export class AuditListDto {
  @ApiProperty({ type: [AuditEntryDto] }) items!: AuditEntryDto[];
  @ApiProperty() total!: number;
  @ApiProperty() page!: number;
  @ApiProperty() pageSize!: number;
  @ApiProperty({ type: [String], description: 'Distinct action names (for filters)' }) actions!: string[];
}

export class SmtpSettingsDto {
  @ApiProperty() enabled!: boolean;
  @ApiProperty({ type: String, nullable: true }) host!: string | null;
  @ApiProperty() port!: number;
  @ApiProperty({ description: 'implicit TLS' }) secure!: boolean;
  @ApiProperty() requireTls!: boolean;
  @ApiProperty() authConfigured!: boolean;
}
export class ResendSettingsDto {
  @ApiProperty() enabled!: boolean;
  @ApiProperty() webhookConfigured!: boolean;
}
export class AuthentikSettingsDto {
  @ApiProperty() enabled!: boolean;
  @ApiProperty({ type: String, nullable: true }) issuer!: string | null;
  @ApiProperty() adminGroup!: string;
  @ApiProperty() viewerGroup!: string;
  @ApiProperty() bodiesGroup!: string;
  @ApiProperty() scopes!: string;
}
export class SettingsDto {
  @ApiProperty({ enum: ['smtp', 'resend'] }) liveProvider!: string;
  @ApiProperty({ type: SmtpSettingsDto }) smtp!: SmtpSettingsDto;
  @ApiProperty({ type: ResendSettingsDto }) resend!: ResendSettingsDto;
  @ApiProperty() mailpitSmtp!: string;
  @ApiProperty({ type: String, nullable: true }) mailpitUiUrl!: string | null;
  @ApiProperty() bodyRetentionDays!: number;
  @ApiProperty() recordRetentionDays!: number;
  @ApiProperty() retentionCron!: string;
  @ApiProperty() globalRateMax!: number;
  @ApiProperty() globalRateDurationMs!: number;
  @ApiProperty() globalAcceptPerHour!: number;
  @ApiProperty() dedupWindowSeconds!: number;
  @ApiProperty() idempotencyTtlSeconds!: number;
  @ApiProperty() deliveryMaxAttempts!: number;
  @ApiProperty() breakerConsecutiveFailures!: number;
  @ApiProperty() breakerFailureRate!: number;
  @ApiProperty() breakerWindowSeconds!: number;
  @ApiProperty() maxRequestBytes!: number;
  @ApiProperty() trustProxy!: string;
  @ApiProperty() localLogin!: boolean;
  @ApiProperty() adminTokenEnabled!: boolean;
  @ApiProperty() sessionTtlHours!: number;
  @ApiProperty() sessionIdleMinutes!: number;
  @ApiProperty({ type: AuthentikSettingsDto }) authentik!: AuthentikSettingsDto;
}
