import { Inject, Injectable } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { APP_CONFIG, AppConfig } from '../config/config';
import { GatewayError } from '../common/errors';
import { PrismaService } from '../common/prisma.service';
import { REDIS } from '../common/redis';

const PENDING = '__pending__';

/**
 * Same key + Idempotency-Key within IDEMPOTENCY_TTL_SECONDS returns the original message.
 * Redis SET NX reserves the key while the request is in flight; the DB unique index
 * (api_key_id, idempotency_key) is the durable backstop.
 */
@Injectable()
export class IdempotencyService {
  constructor(
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
    private readonly prisma: PrismaService,
  ) {}

  static validate(key: string | undefined): string | undefined {
    if (key === undefined || key === '') return undefined;
    if (key.length > 255 || !/^[\x21-\x7e]+$/.test(key)) {
      throw new GatewayError('VALIDATION_FAILED', 'Idempotency-Key must be 1-255 printable ASCII characters without spaces.');
    }
    return key;
  }

  private rkey(keyId: string, idem: string) {
    return `mg:idem:${keyId}:${idem}`;
  }

  /** Returns the original message id if this request was already accepted, else reserves the key (null). */
  async reserve(keyId: string, idem: string): Promise<string | null> {
    const k = this.rkey(keyId, idem);
    const ok = await this.redis.set(k, PENDING, 'EX', 60, 'NX');
    if (ok === 'OK') {
      // Redis may have lost the mapping (restart/eviction): check the durable record.
      const since = new Date(Date.now() - this.cfg.IDEMPOTENCY_TTL_SECONDS * 1000);
      const existing = await this.prisma.message.findFirst({
        where: { apiKeyId: keyId, idempotencyKey: idem, createdAt: { gte: since } },
        select: { id: true },
      });
      if (existing) {
        await this.redis.set(k, existing.id, 'EX', this.cfg.IDEMPOTENCY_TTL_SECONDS);
        return existing.id;
      }
      return null;
    }
    const v = await this.redis.get(k);
    if (v === PENDING || v === null) {
      throw new GatewayError('IDEMPOTENCY_CONFLICT', 'A request with this Idempotency-Key is still being processed. Retry in a few seconds.', {
        retryAfterSeconds: 2,
      });
    }
    return v;
  }

  async commit(keyId: string, idem: string, messageId: string): Promise<void> {
    await this.redis.set(this.rkey(keyId, idem), messageId, 'EX', this.cfg.IDEMPOTENCY_TTL_SECONDS);
  }

  async release(keyId: string, idem: string): Promise<void> {
    const k = this.rkey(keyId, idem);
    const v = await this.redis.get(k);
    if (v === PENDING) await this.redis.del(k);
  }
}
