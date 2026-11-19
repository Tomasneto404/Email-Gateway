// Authored by Tomás Neto (TN 2026)
import { Inject, Injectable, Optional } from '@nestjs/common';
import type { Logger } from 'pino';
import { MetricsService } from '../metrics/metrics.service';
import { ROOT_LOGGER } from './logger';

export type GatewayEvent =
  | 'message_accepted'
  | 'message_replayed'
  | 'policy_rejected'
  | 'auth_failed'
  | 'auth_rate_limited'
  | 'delivery_succeeded'
  | 'delivery_retry'
  | 'delivery_failed'
  | 'delivery_skipped'
  | 'provider_event'
  | 'breaker_tripped'
  | 'gateway_paused'
  | 'gateway_resumed'
  | 'message_approved'
  | 'message_rejected_by_admin'
  | 'retention_completed'
  | 'system_mail_queued'
  | 'system_mail_sent'
  | 'system_mail_failed'
  | 'admin_action'
  | 'login_succeeded'
  | 'login_failed'
  | 'alert_raised'
  | 'alert_enqueue_failed'
  | 'alert_failed'
  | 'alert_delivery_failed'
  | 'ip_not_allowed'
  | 'key_expired'
  | 'previous_key_used';

export interface EventFields {
  keyName?: string;
  keyId?: string;
  messageId?: string;
  outcome?: 'success' | 'failure' | 'rejected' | 'retry' | 'info';
  reason?: string;
  [k: string]: unknown;
}

/**
 * Structured security/ops events with consistent fields
 * (event, keyName, messageId, outcome, reason) for SIEM shipping.
 */
@Injectable()
export class EventLogger {
  constructor(
    @Inject(ROOT_LOGGER) private readonly logger: Logger,
    @Optional() private readonly metrics?: MetricsService,
  ) {}

  emit(event: GatewayEvent, fields: EventFields = {}): void {
    const level = fields.outcome === 'failure' || fields.outcome === 'rejected' ? 'warn' : 'info';
    this.logger[level]({ event, ...fields }, event);
    this.count(event, fields);
  }

  /** Every metric that mirrors an event is counted here, exactly once. */
  private count(event: GatewayEvent, f: EventFields) {
    const m = this.metrics;
    if (!m) return;
    const key = f.keyName ?? 'unknown';
    switch (event) {
      case 'message_accepted':
        m.messages.inc({ status: String(f.status ?? 'queued'), key });
        break;
      case 'policy_rejected':
        m.messages.inc({ status: 'rejected', key });
        m.rejections.inc({ reason: f.reason ?? 'unknown', key });
        break;
      case 'delivery_succeeded':
        m.messages.inc({ status: String(f.status ?? 'sent'), key });
        break;
      case 'delivery_failed':
        if (f.messageId) m.messages.inc({ status: 'failed', key });
        break;
      case 'auth_failed':
      case 'auth_rate_limited':
      case 'login_failed':
        m.authFailures.inc({ reason: f.reason ?? event });
        break;
      case 'provider_event':
        if (f.deliveryOutcome) m.deliveryOutcomes.inc({ outcome: String(f.deliveryOutcome), key });
        break;
      case 'breaker_tripped':
        m.breakerTrips.inc({ provider: String(f.provider ?? 'unknown') });
        break;
      default:
    }
  }
}
