// Authored by Tomás Neto (TN 2026)
import { Inject, Injectable } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { APP_CONFIG, AppConfig } from '../config/config';
import { GatewayError } from '../common/errors';
import { REDIS } from '../common/redis';
import { windows } from '../common/time';

/**
 * Atomic check-and-increment over three fixed UTC windows:
 * per-key hour, per-key day, global hour. Nothing is incremented unless all pass.
 * Returns {status, hourCount, dayCount, globalCount}; status 1 = ok, -1 hour, -2 day, -3 global.
 */
const CONSUME_LUA = `
local h = tonumber(redis.call('GET', KEYS[1]) or '0')
local d = tonumber(redis.call('GET', KEYS[2]) or '0')
local g = tonumber(redis.call('GET', KEYS[3]) or '0')
if g >= tonumber(ARGV[3]) then return {-3, h, d, g} end
if h >= tonumber(ARGV[1]) then return {-1, h, d, g} end
if d >= tonumber(ARGV[2]) then return {-2, h, d, g} end
h = redis.call('INCR', KEYS[1])
if h == 1 then redis.call('EXPIRE', KEYS[1], ARGV[4]) end
d = redis.call('INCR', KEYS[2])
if d == 1 then redis.call('EXPIRE', KEYS[2], ARGV[5]) end
g = redis.call('INCR', KEYS[3])
if g == 1 then redis.call('EXPIRE', KEYS[3], ARGV[4]) end
return {1, h, d, g}
`;

export interface QuotaLimits {
  keyId: string;
  keyName: string;
  quotaPerHour: number;
  quotaPerDay: number;
}

export interface QuotaTicket {
  keys: [string, string, string];
}

export interface QuotaUsage {
  hour: number;
  day: number;
}

@Injectable()
export class QuotaService {
  constructor(
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
  ) {}

  private keysFor(keyId: string, now = new Date()) {
    const w = windows(now);
    return {
      w,
      keys: [`mg:q:${keyId}:h:${w.hour}`, `mg:q:${keyId}:d:${w.day}`, `mg:q:global:h:${w.hour}`] as [string, string, string],
    };
  }

  async consume(l: QuotaLimits, now = new Date()): Promise<QuotaTicket> {
    const { w, keys } = this.keysFor(l.keyId, now);
    const res = (await this.redis.eval(
      CONSUME_LUA,
      3,
      ...keys,
      l.quotaPerHour,
      l.quotaPerDay,
      this.cfg.GLOBAL_ACCEPT_PER_HOUR,
      w.hourResetSeconds + 60,
      w.dayResetSeconds + 60,
    )) as number[];
    const [status] = res;
    if (status === -1) {
      throw new GatewayError(
        'QUOTA_EXCEEDED',
        `Key "${l.keyName}" reached its hourly quota of ${l.quotaPerHour} messages. Do not retry before the window resets in ${w.hourResetSeconds}s.`,
        { window: 'hour', limit: l.quotaPerHour, retryAfterSeconds: w.hourResetSeconds },
      );
    }
    if (status === -2) {
      throw new GatewayError(
        'QUOTA_EXCEEDED',
        `Key "${l.keyName}" reached its daily quota of ${l.quotaPerDay} messages. Do not retry before the window resets in ${w.dayResetSeconds}s (00:00 UTC).`,
        { window: 'day', limit: l.quotaPerDay, retryAfterSeconds: w.dayResetSeconds },
      );
    }
    if (status === -3) {
      throw new GatewayError(
        'GLOBAL_RATE_LIMITED',
        `The gateway reached its global hourly sending limit. Retry after ${w.hourResetSeconds}s.`,
        { retryAfterSeconds: w.hourResetSeconds },
      );
    }
    return { keys };
  }

  /** Undo a successful consume() when a later pipeline step rejects the message. */
  async rollback(t: QuotaTicket): Promise<void> {
    await this.redis.multi().decr(t.keys[0]).decr(t.keys[1]).decr(t.keys[2]).exec();
  }

  async usage(keyIds: string[], now = new Date()): Promise<Record<string, QuotaUsage>> {
    if (!keyIds.length) return {};
    const flat = keyIds.flatMap((id) => this.keysFor(id, now).keys.slice(0, 2));
    const vals = await this.redis.mget(...flat);
    const out: Record<string, QuotaUsage> = {};
    keyIds.forEach((id, i) => {
      out[id] = { hour: Number(vals[i * 2] ?? 0), day: Number(vals[i * 2 + 1] ?? 0) };
    });
    return out;
  }
}
