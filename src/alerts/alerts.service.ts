// Authored by Tomás Neto (TN 2026)
import { Inject, Injectable } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { APP_CONFIG, AppConfig } from '../config/config';
import { EventLogger } from '../common/event-logger';
import { PrismaService } from '../common/prisma.service';
import { REDIS } from '../common/redis';
import { Prisma } from '../generated/prisma/client';
import { QueueService } from '../queue/queue.service';

export const ALERT_TYPES = [
  { type: 'breaker_tripped', severity: 'critical', label: 'A provider circuit breaker tripped and paused the gateway' },
  { type: 'gateway_paused', severity: 'warning', label: 'The gateway was paused by an administrator' },
  { type: 'gateway_resumed', severity: 'info', label: 'The gateway was resumed' },
  { type: 'rejection_spike', severity: 'warning', label: 'Many requests rejected by the guardrails in a short window' },
  { type: 'delivery_failures', severity: 'warning', label: 'Many deliveries failed in a short window' },
  { type: 'quota_threshold', severity: 'warning', label: 'A key used most of its hourly or daily quota' },
  { type: 'approvals_waiting', severity: 'info', label: 'Messages waiting for approval for too long' },
  { type: 'key_expiring', severity: 'warning', label: 'An API key expires soon' },
  { type: 'audit_chain_broken', severity: 'critical', label: 'The activity log failed its integrity check' },
  { type: 'test', severity: 'info', label: 'Test alert sent from the admin UI' },
] as const;

export type AlertType = (typeof ALERT_TYPES)[number]['type'];
export type AlertSeverity = 'info' | 'warning' | 'critical';
export const ALERT_TYPE_IDS = ALERT_TYPES.map((t) => t.type) as AlertType[];

export interface AlertJob {
  eventId: string;
}

/**
 * Raises alerts: stores them (history) and queues their delivery to the subscribed channels
 * (webhook, Slack, email), done by the worker. `dedupKey` + ALERT_COOLDOWN_MINUTES stop the same
 * condition from alerting again while it persists.
 */
@Injectable()
export class AlertsService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
    private readonly queues: QueueService,
    private readonly events: EventLogger,
  ) {}

  async raise(type: AlertType, title: string, detail: Record<string, unknown> = {}, dedupKey?: string): Promise<string | null> {
    if (dedupKey) {
      const fresh = await this.redis.set(`mg:alert:cd:${type}:${dedupKey}`, '1', 'EX', this.cfg.ALERT_COOLDOWN_MINUTES * 60, 'NX');
      if (!fresh) return null;
    }
    const severity = (ALERT_TYPES.find((t) => t.type === type)?.severity ?? 'info') as AlertSeverity;
    const ev = await this.prisma.alertEvent.create({ data: { type, severity, title: title.slice(0, 500), detail: detail as Prisma.InputJsonValue } });
    this.events.emit('alert_raised', { outcome: severity === 'critical' ? 'failure' : 'info', alert: type, severity, title });
    try {
      await this.queues.alerts.add('deliver', { eventId: ev.id }, { attempts: 4, backoff: { type: 'exponential', delay: 15_000 }, removeOnComplete: 1000, removeOnFail: 1000 });
    } catch (e) {
      // Never let alerting break the action that raised it.
      this.events.emit('alert_enqueue_failed', { outcome: 'failure', alert: type, error: (e as Error).message });
    }
    return ev.id;
  }

  /** Fire-and-forget variant for hot paths. */
  raiseSoon(type: AlertType, title: string, detail: Record<string, unknown> = {}, dedupKey?: string) {
    void this.raise(type, title, detail, dedupKey).catch((e) => this.events.emit('alert_failed', { outcome: 'failure', alert: type, error: (e as Error).message }));
  }
}
