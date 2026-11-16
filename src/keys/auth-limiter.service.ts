import { Inject, Injectable } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { APP_CONFIG, AppConfig } from '../config/config';
import { REDIS } from '../common/redis';

/** Per-IP failed authentication counter (fixed window). */
@Injectable()
export class AuthLimiterService {
  constructor(
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
  ) {}

  private key(scope: string, ip: string) {
    return `mg:authfail:${scope}:${ip}`;
  }

  async isBlocked(scope: string, ip: string, max = this.cfg.AUTH_FAIL_MAX): Promise<number | null> {
    const k = this.key(scope, ip);
    const n = Number((await this.redis.get(k)) ?? 0);
    if (n < max) return null;
    const ttl = await this.redis.ttl(k);
    return ttl > 0 ? ttl : this.cfg.AUTH_FAIL_WINDOW_SECONDS;
  }

  async recordFailure(scope: string, ip: string, windowSeconds = this.cfg.AUTH_FAIL_WINDOW_SECONDS): Promise<number> {
    const k = this.key(scope, ip);
    const n = await this.redis.incr(k);
    if (n === 1) await this.redis.expire(k, windowSeconds);
    return n;
  }

  async reset(scope: string, ip: string) {
    await this.redis.del(this.key(scope, ip));
  }
}
