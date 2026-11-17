import { RedisContainer, StartedRedisContainer } from '@testcontainers/redis';
import IORedis, { Redis } from 'ioredis';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AppConfig, buildConfig } from '../../src/config/config';
import { GatewayError } from '../../src/common/errors';
import { DedupService } from '../../src/policy/dedup.service';
import { IdempotencyService } from '../../src/policy/idempotency.service';
import { QuotaService } from '../../src/policy/quota.service';

let container: StartedRedisContainer | undefined;
let redis: Redis;
let cfg: AppConfig;

beforeAll(async () => {
  // CI provides Redis as a service (TEST_REDIS_URL); locally a throwaway container is started.
  const external = process.env.MG_TEST_SERVICES === 'external' ? process.env.TEST_REDIS_URL : undefined;
  if (!external) container = await new RedisContainer('redis:7-alpine').start();
  redis = new IORedis(external ?? container!.getConnectionUrl());
  cfg = buildConfig({ DATABASE_URL: 'postgres://unused', GLOBAL_ACCEPT_PER_HOUR: '5', DEDUP_WINDOW_SECONDS: '60' });
});
afterAll(async () => {
  redis?.disconnect();
  await container?.stop();
});
beforeEach(() => redis.flushdb());

const code = async (p: Promise<unknown>) => p.then(() => null).catch((e: GatewayError) => e.code);

describe('QuotaService', () => {
  const limits = { keyId: 'k1', keyName: 'k1', quotaPerHour: 2, quotaPerDay: 3 };

  it('enforces the hourly quota atomically', async () => {
    const q = new QuotaService(redis, cfg);
    await q.consume(limits);
    await q.consume(limits);
    expect(await code(q.consume(limits))).toBe('QUOTA_EXCEEDED');
    expect((await q.usage(['k1'])).k1).toEqual({ hour: 2, day: 2 });
  });

  it('enforces the daily quota across hours', async () => {
    const q = new QuotaService(redis, cfg);
    const t0 = new Date('2026-11-16T10:30:00Z');
    const t1 = new Date('2026-11-16T11:30:00Z');
    await q.consume(limits, t0);
    await q.consume(limits, t0);
    await q.consume(limits, t1);
    const err = (await q.consume(limits, t1).catch((e: GatewayError) => e)) as GatewayError;
    expect(err.code).toBe('QUOTA_EXCEEDED');
    expect(err.details).toMatchObject({ window: 'day', limit: 3 });
  });

  it('does not increment anything when rejected, and rollback releases', async () => {
    const q = new QuotaService(redis, cfg);
    const t = await q.consume(limits);
    await q.consume(limits);
    await code(q.consume(limits));
    expect((await q.usage(['k1'])).k1.hour).toBe(2);
    await q.rollback(t);
    expect((await q.usage(['k1'])).k1.hour).toBe(1);
  });

  it('global hourly cap applies across keys', async () => {
    const q = new QuotaService(redis, cfg);
    for (let i = 0; i < 5; i++) await q.consume({ ...limits, keyId: `k${i}`, keyName: `k${i}` });
    expect(await code(q.consume({ ...limits, keyId: 'other', keyName: 'other' }))).toBe('GLOBAL_RATE_LIMITED');
  });

  it('is race-safe under concurrency', async () => {
    const q = new QuotaService(redis, cfg);
    const res = await Promise.all(Array.from({ length: 20 }, () => code(q.consume({ ...limits, quotaPerHour: 4, quotaPerDay: 100 }))));
    expect(res.filter((r) => r === null)).toHaveLength(4);
  });
});

describe('DedupService', () => {
  it('rejects the same hash within the window, release allows again', async () => {
    const d = new DedupService(redis, cfg);
    await d.claim('h1', 'k');
    expect(await code(d.claim('h1', 'k'))).toBe('DUPLICATE_MESSAGE');
    await d.claim('h2', 'k');
    await d.release('h1');
    await d.claim('h1', 'k');
    expect(await redis.ttl('mg:dedup:h1')).toBeGreaterThan(50);
  });
});

describe('IdempotencyService', () => {
  const prisma = (found: { id: string } | null) => ({ message: { findFirst: async () => found } }) as never;

  it('reserve → commit → replay returns the original id', async () => {
    const i = new IdempotencyService(redis, cfg, prisma(null));
    expect(await i.reserve('k1', 'abc')).toBeNull();
    await i.commit('k1', 'abc', 'msg-1');
    expect(await i.reserve('k1', 'abc')).toBe('msg-1');
    expect(await i.reserve('k2', 'abc')).toBeNull(); // scoped per key
  });

  it('concurrent in-flight request → IDEMPOTENCY_CONFLICT; release after rejection allows retry', async () => {
    const i = new IdempotencyService(redis, cfg, prisma(null));
    expect(await i.reserve('k1', 'x')).toBeNull();
    expect(await code(i.reserve('k1', 'x'))).toBe('IDEMPOTENCY_CONFLICT');
    await i.release('k1', 'x');
    expect(await i.reserve('k1', 'x')).toBeNull();
  });

  it('falls back to the durable record when Redis lost the mapping', async () => {
    const i = new IdempotencyService(redis, cfg, prisma({ id: 'msg-db' }));
    expect(await i.reserve('k1', 'lost')).toBe('msg-db');
  });

  it('validates the header value', () => {
    expect(IdempotencyService.validate(undefined)).toBeUndefined();
    expect(IdempotencyService.validate('ok-123')).toBe('ok-123');
    expect(() => IdempotencyService.validate('has space')).toThrow(GatewayError);
    expect(() => IdempotencyService.validate('x'.repeat(256))).toThrow(GatewayError);
  });
});
