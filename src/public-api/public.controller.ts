import { Body, Controller, Get, Headers, HttpCode, Param, Post, Req, Res, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiHeader, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { GatewayError } from '../common/errors';
import { clientIp } from '../common/http';
import { ApiKeyGuard, ApiKeyRequest } from '../keys/api-key.guard';
import { toPolicyView } from '../keys/keys.service';
import { toStatusView } from '../messages/messages.repository';
import { MessagesRepository } from '../messages/messages.repository';
import { QuotaService } from '../policy/quota.service';
import { SendAcceptedDto, SendDto } from '../send/send.dto';
import { SendService } from '../send/send.service';
import { ErrorResponseDto, MeResponseDto, MessageStatusDto } from './public.dto';

@ApiTags('send')
@ApiBearerAuth('apiKey')
@UseGuards(ApiKeyGuard)
@Controller('v1')
export class PublicController {
  constructor(
    private readonly send: SendService,
    private readonly messages: MessagesRepository,
    private readonly quota: QuotaService,
  ) {}

  @Post('send')
  @HttpCode(202)
  @ApiOperation({
    operationId: 'sendEmail',
    summary: 'Queue an email for delivery',
    description:
      'Queues one email. The sender (from) is fixed by your API key and cannot be set. All recipients (to, cc, bcc) must be allowed by your key policy, ' +
      'and the message must fit your size, attachment and quota limits; call GET /v1/me first to discover them. ' +
      'Identical messages within the dedup window are rejected with DUPLICATE_MESSAGE (do not loop). ' +
      'To retry safely after a network error, resend with the same Idempotency-Key header: the original message is returned instead of a new one. ' +
      'On error, read error.code and error.message: they say exactly what to change.',
  })
  @ApiBody({ type: SendDto })
  @ApiHeader({ name: 'Idempotency-Key', required: false, description: 'Optional, 1-255 printable ASCII chars. Same key within 24h returns the original message.' })
  @ApiResponse({ status: 202, type: SendAcceptedDto, description: 'Accepted. Header Idempotent-Replayed: true when an earlier request with the same Idempotency-Key is returned.' })
  @ApiResponse({ status: 400, type: ErrorResponseDto, description: 'VALIDATION_FAILED, FROM_NOT_ALLOWED, TOO_MANY_RECIPIENTS, REPLY_TO_NOT_ALLOWED, ATTACHMENTS_NOT_ALLOWED' })
  @ApiResponse({ status: 401, type: ErrorResponseDto, description: 'UNAUTHORIZED, INVALID_API_KEY' })
  @ApiResponse({ status: 403, type: ErrorResponseDto, description: 'RECIPIENT_NOT_ALLOWED, KEY_DISABLED' })
  @ApiResponse({ status: 409, type: ErrorResponseDto, description: 'DUPLICATE_MESSAGE, IDEMPOTENCY_CONFLICT' })
  @ApiResponse({ status: 413, type: ErrorResponseDto, description: 'MESSAGE_TOO_LARGE, ATTACHMENT_TOO_LARGE, REQUEST_TOO_LARGE' })
  @ApiResponse({ status: 429, type: ErrorResponseDto, description: 'QUOTA_EXCEEDED, GLOBAL_RATE_LIMITED, AUTH_RATE_LIMITED (see Retry-After)' })
  @ApiResponse({ status: 503, type: ErrorResponseDto, description: 'GATEWAY_PAUSED, PROVIDER_UNAVAILABLE, QUEUE_UNAVAILABLE' })
  async sendEmail(
    @Req() req: ApiKeyRequest,
    @Body() body: unknown,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ) {
    const r = await this.send.submit({ apiKey: req.apiKey, sourceIp: clientIp(req), source: 'api', idempotencyKey }, body);
    if (r.replayed) res.setHeader('Idempotent-Replayed', 'true');
    return { id: r.id, status: r.status };
  }

  @Get('messages/:id')
  @ApiOperation({
    operationId: 'getMessageStatus',
    summary: 'Get the delivery status of one of your messages',
    description:
      'Status values: queued, pending_approval (waiting for an admin), sent (accepted by the live provider), captured (sandbox: delivered to Mailpit only), failed, rejected. ' +
      'Only messages sent with the calling key are visible.',
  })
  @ApiResponse({ status: 200, type: MessageStatusDto })
  @ApiResponse({ status: 404, type: ErrorResponseDto, description: 'MESSAGE_NOT_FOUND' })
  async getMessage(@Req() req: ApiKeyRequest, @Param('id') id: string) {
    const m = await this.messages.findById(id);
    if (!m || m.apiKeyId !== req.apiKey.id) {
      throw new GatewayError('MESSAGE_NOT_FOUND', `Message ${id} not found for this API key.`);
    }
    return toStatusView(m);
  }

  @Get('me')
  @ApiOperation({
    operationId: 'getMyPolicy',
    summary: 'Discover what your API key is allowed to do',
    description: 'Returns the calling key\'s policy (allowed recipients, limits, quotas, mode) and current quota usage. Call this before sending.',
  })
  @ApiResponse({ status: 200, type: MeResponseDto })
  async me(@Req() req: ApiKeyRequest) {
    const k = req.apiKey;
    const usage = (await this.quota.usage([k.id]))[k.id] ?? { hour: 0, day: 0 };
    const { id: _id, keyPrefix, ...view } = toPolicyView(k);
    return {
      ...view,
      keyPrefix,
      usage: {
        hour: { used: usage.hour, limit: k.quotaPerHour, remaining: Math.max(0, k.quotaPerHour - usage.hour) },
        day: { used: usage.day, limit: k.quotaPerDay, remaining: Math.max(0, k.quotaPerDay - usage.day) },
      },
    };
  }
}
