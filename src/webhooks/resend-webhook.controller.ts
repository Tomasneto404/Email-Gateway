// Authored by Tomás Neto (TN 2026)
import { Controller, HttpCode, Inject, Post, Req } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import type { Request } from 'express';
import { Webhook } from 'svix';
import { APP_CONFIG, AppConfig } from '../config/config';
import { EventLogger } from '../common/event-logger';
import { GatewayError } from '../common/errors';
import { PrismaService } from '../common/prisma.service';
import { MessagesRepository } from '../messages/messages.repository';

/** Resend event type → our delivery outcome. Unlisted types are recorded but don't change the outcome. */
export const RESEND_OUTCOMES: Record<string, string> = {
  'email.delivered': 'delivered',
  'email.delivery_delayed': 'delayed',
  'email.bounced': 'bounced',
  'email.complained': 'complained',
};
/** Worse outcomes are sticky: a late "delivered" never hides an earlier bounce/complaint. */
const SEVERITY: Record<string, number> = { delayed: 1, delivered: 2, bounced: 3, complained: 4 };

interface ResendEvent {
  type: string;
  created_at?: string;
  data?: { email_id?: string; bounce?: { type?: string; subType?: string; message?: string }; to?: string[] };
}

@ApiExcludeController()
@Controller('webhooks')
export class ResendWebhookController {
  constructor(
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
    private readonly prisma: PrismaService,
    private readonly repo: MessagesRepository,
    private readonly events: EventLogger,
  ) {}

  @Post('resend')
  @HttpCode(200)
  async resend(@Req() req: Request) {
    if (!this.cfg.RESEND_WEBHOOK_SECRET) throw new GatewayError('NOT_FOUND', 'Not found');
    const payload = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : '';
    let evt: ResendEvent;
    try {
      // Verifies the svix signature and rejects timestamps outside the tolerance window (replay protection).
      new Webhook(this.cfg.RESEND_WEBHOOK_SECRET).verify(payload, {
        'svix-id': String(req.headers['svix-id'] ?? ''),
        'svix-timestamp': String(req.headers['svix-timestamp'] ?? ''),
        'svix-signature': String(req.headers['svix-signature'] ?? ''),
      });
      // svix only verifies; parse after the signature is known-good.
      evt = JSON.parse(payload) as ResendEvent;
    } catch {
      this.events.emit('auth_failed', { outcome: 'rejected', reason: 'INVALID_WEBHOOK_SIGNATURE', ip: req.ip });
      throw new GatewayError('UNAUTHORIZED', 'Invalid webhook signature');
    }

    const emailId = evt.data?.email_id;
    if (!emailId) return { ok: true, ignored: 'no email_id' };
    const msg = await this.prisma.message.findFirst({
      where: { provider: 'resend', providerMessageId: emailId },
      include: { apiKey: { select: { name: true } } },
    });
    if (!msg) return { ok: true, ignored: 'unknown email_id' };

    const outcome = RESEND_OUTCOMES[evt.type];
    await this.repo.addEvent(msg.id, 'provider_event', {
      provider: 'resend',
      type: evt.type,
      at: evt.created_at,
      ...(evt.data?.bounce ? { bounce: evt.data.bounce } : {}),
    });
    if (outcome) {
      const current = msg.deliveryOutcome ? (SEVERITY[msg.deliveryOutcome] ?? 0) : 0;
      if (SEVERITY[outcome] >= current) await this.repo.update(msg.id, { deliveryOutcome: outcome });
      await this.repo.bumpStats(this.prisma, msg.apiKeyId, `outcome:${outcome}`);
    }
    this.events.emit('provider_event', {
      keyName: msg.apiKey.name,
      messageId: msg.id,
      outcome: outcome === 'bounced' || outcome === 'complained' ? 'failure' : 'info',
      provider: 'resend',
      reason: evt.type,
      deliveryOutcome: outcome,
    });
    return { ok: true };
  }
}
