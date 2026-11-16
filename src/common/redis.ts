import { Inject, Injectable, OnModuleDestroy } from '@nestjs/common';
import IORedis, { Redis } from 'ioredis';
import { APP_CONFIG, AppConfig } from '../config/config';

export const REDIS = Symbol('REDIS');

/** Owns the shared ioredis connection (commands only; BullMQ creates its own). */
@Injectable()
export class RedisHolder implements OnModuleDestroy {
  readonly client: Redis;
  constructor(@Inject(APP_CONFIG) cfg: AppConfig) {
    this.client = new IORedis(cfg.REDIS_URL, { maxRetriesPerRequest: 2, enableReadyCheck: true, lazyConnect: false });
  }
  async onModuleDestroy() {
    await this.client.quit().catch(() => this.client.disconnect());
  }
}

export const redisProvider = {
  provide: REDIS,
  inject: [RedisHolder],
  useFactory: (h: RedisHolder) => h.client,
};
