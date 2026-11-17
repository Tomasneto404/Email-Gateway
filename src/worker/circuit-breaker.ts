// Authored by Tomás Neto (TN 2026)
import { Inject, Injectable } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { randomUUID } from 'node:crypto';
import { SYSTEM_ACTOR } from '../admin/admin-audit.service';
import { APP_CONFIG, AppConfig } from '../config/config';
import { EventLogger } from '../common/event-logger';
import { REDIS } from '../common/redis';
import { GatewayStateService } from '../gateway-state/gateway-state.service';

export interface BreakerStats {
  consecutive: number;
  samples: number;
  failures: number;
}

export interface BreakerConfig {
  consecutiveFailures: number;
  failureRate: number;
  minSamples: number;
}

/**
 * Trip when N consecutive systemic (transport-level) failures happen, or when the failure rate
 * of all attempts in the sliding window passes the threshold (with enough samples).
 */
export function shouldTrip(s: BreakerStats, c: BreakerConfig): false | 'consecutive' | 'failure_rate' {
  if (s.consecutive >= c.consecutiveFailures) return 'consecutive';
  if (s.samples >= c.minSamples && s.failures / s.samples >= c.failureRate) return 'failure_rate';
  return false;
}

/** Redis-backed breaker, one per live provider. Tripping pauses the whole gateway (admin resume resets). */
@Injectable()
export class CircuitBreakerService {
  constructor(
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
    private readonly gateway: GatewayStateService,
    private readonly events: EventLogger,
  ) {}

  private k(p: string, part: string) {
    return `mg:cb:${p}:${part}`;
  }

  async recordSuccess(provider: string) {
    const now = Date.now();
    await this.redis
      .multi()
      .set(this.k(provider, 'consec'), '0')
      .zadd(this.k(provider, 'win'), now, `${now}:ok:${randomUUID()}`)
      .zremrangebyscore(this.k(provider, 'win'), 0, now - this.cfg.BREAKER_WINDOW_SECONDS * 1000)
      .exec();
  }

  /** Returns the trip reason if this failure tripped the breaker. */
  async recordFailure(provider: string, systemic: boolean): Promise<false | string> {
    const now = Date.now();
    const winKey = this.k(provider, 'win');
    const multi = this.redis.multi();
    if (systemic) multi.incr(this.k(provider, 'consec'));
    else multi.get(this.k(provider, 'consec'));
    multi
      .zadd(winKey, now, `${now}:fail:${randomUUID()}`)
      .zremrangebyscore(winKey, 0, now - this.cfg.BREAKER_WINDOW_SECONDS * 1000)
      .zrange(winKey, 0, -1)
      .expire(winKey, this.cfg.BREAKER_WINDOW_SECONDS * 2);
    const res = (await multi.exec()) ?? [];
    const consecutive = Number(res[0]?.[1] ?? 0);
    const members = (res[3]?.[1] as string[]) ?? [];
    const failures = members.filter((m) => m.includes(':fail:')).length;
    const reason = shouldTrip(
      { consecutive, samples: members.length, failures },
      { consecutiveFailures: this.cfg.BREAKER_CONSECUTIVE_FAILURES, failureRate: this.cfg.BREAKER_FAILURE_RATE, minSamples: this.cfg.BREAKER_MIN_SAMPLES },
    );
    if (!reason) return false;
    // Only the first tripper pauses the gateway.
    const first = await this.redis.set(this.k(provider, 'state'), 'open', 'NX');
    if (first === 'OK') {
      this.events.emit('breaker_tripped', { provider, reason, consecutive, samples: members.length, failures, outcome: 'failure' });
      await this.gateway.pause(`circuit_breaker:${provider} (${reason})`, SYSTEM_ACTOR, { breaker: true });
    }
    return reason;
  }

  async state(provider: string): Promise<'open' | 'closed'> {
    return (await this.redis.get(this.k(provider, 'state'))) === 'open' ? 'open' : 'closed';
  }
}
