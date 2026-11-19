// Authored by Tomás Neto (TN 2026)
import { Inject, Injectable, OnModuleDestroy } from '@nestjs/common';
import { ConnectionOptions, JobsOptions, Queue } from 'bullmq';
import { APP_CONFIG, AppConfig } from '../config/config';

export const DELIVERY_QUEUE = 'delivery';
export const MAINTENANCE_QUEUE = 'maintenance';
export const SYSTEM_MAIL_QUEUE = 'system-mail';
export const ALERTS_QUEUE = 'alerts';

export interface SystemMailJob {
  kind: 'invite' | 'alert';
  to: string;
  subject: string;
  text: string;
  html: string;
}
export const QUEUE_PREFIX = 'mg';

export interface DeliveryJob {
  messageId: string;
}

export function redisConnection(url: string): ConnectionOptions {
  return { url, maxRetriesPerRequest: null } as ConnectionOptions;
}

@Injectable()
export class QueueService implements OnModuleDestroy {
  readonly delivery: Queue<DeliveryJob>;
  readonly maintenance: Queue;
  readonly systemMail: Queue<SystemMailJob>;
  readonly alerts: Queue;

  constructor(@Inject(APP_CONFIG) private readonly cfg: AppConfig) {
    const connection = redisConnection(cfg.REDIS_URL);
    this.delivery = new Queue<DeliveryJob>(DELIVERY_QUEUE, { connection, prefix: QUEUE_PREFIX });
    this.maintenance = new Queue(MAINTENANCE_QUEUE, { connection, prefix: QUEUE_PREFIX });
    this.systemMail = new Queue<SystemMailJob>(SYSTEM_MAIL_QUEUE, { connection, prefix: QUEUE_PREFIX });
    this.alerts = new Queue(ALERTS_QUEUE, { connection, prefix: QUEUE_PREFIX });
    // Without a listener, a Redis disconnect (e.g. during shutdown) is an unhandled 'error' event
    // and crashes the process. ioredis reconnects on its own; operations surface their own errors.
    for (const q of this.all) q.on('error', () => undefined);
  }

  private get all(): Queue[] {
    return [this.delivery, this.maintenance, this.systemMail, this.alerts] as Queue[];
  }

  deliveryJobOptions(messageId: string): JobsOptions {
    return {
      jobId: messageId,
      attempts: this.cfg.DELIVERY_MAX_ATTEMPTS,
      backoff: { type: 'exponential', delay: this.cfg.DELIVERY_BACKOFF_MS },
      removeOnComplete: { age: 86_400, count: 10_000 },
      removeOnFail: { age: 7 * 86_400 },
    };
  }

  async enqueueDelivery(messageId: string): Promise<void> {
    await this.delivery.add('deliver', { messageId }, this.deliveryJobOptions(messageId));
  }

  async depth() {
    return this.delivery.getJobCounts('waiting', 'active', 'delayed', 'failed', 'paused', 'prioritized');
  }

  async onModuleDestroy() {
    // Closing while BullMQ is still connecting makes its init() reject after our listeners are gone
    // (unhandled 'error' → crash). Short-lived processes like the CLI hit this; wait for readiness first.
    const all = this.all;
    await Promise.allSettled(all.map((q) => q.waitUntilReady()));
    await Promise.allSettled(all.map((q) => q.close()));
  }
}
