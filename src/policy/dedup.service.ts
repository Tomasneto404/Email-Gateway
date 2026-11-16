import { Inject, Injectable } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { APP_CONFIG, AppConfig } from '../config/config';
import { GatewayError } from '../common/errors';
import { REDIS } from '../common/redis';

/** Rejects identical messages (same key, recipients, subject, body) inside DEDUP_WINDOW_SECONDS. */
@Injectable()
export class DedupService {
  constructor(
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
  ) {}

  get windowSeconds() {
    return this.cfg.DEDUP_WINDOW_SECONDS;
  }

  async claim(hash: string, keyName: string): Promise<void> {
    if (this.cfg.DEDUP_WINDOW_SECONDS <= 0) return;
    const k = `mg:dedup:${hash}`;
    const ok = await this.redis.set(k, '1', 'EX', this.cfg.DEDUP_WINDOW_SECONDS, 'NX');
    if (ok !== 'OK') {
      const ttl = await this.redis.ttl(k);
      throw new GatewayError(
        'DUPLICATE_MESSAGE',
        `An identical message (same recipients, subject and body) was already sent with key "${keyName}" in the last ${this.cfg.DEDUP_WINDOW_SECONDS}s. ` +
          'This looks like a loop: do not resend. If this is intentional, change the content or wait ' +
          `${ttl > 0 ? ttl : this.cfg.DEDUP_WINDOW_SECONDS}s. To safely retry a request, use the Idempotency-Key header instead.`,
        { retryAfterSeconds: ttl > 0 ? ttl : this.cfg.DEDUP_WINDOW_SECONDS },
      );
    }
  }

  async release(hash: string): Promise<void> {
    await this.redis.del(`mg:dedup:${hash}`);
  }
}
