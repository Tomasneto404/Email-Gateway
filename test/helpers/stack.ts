import 'reflect-metadata';
import { INestApplication, INestApplicationContext } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Writable } from 'node:stream';
import request from 'supertest';
import { inject } from 'vitest';
import { ApiModule } from '../../src/api.module';
import { configureApp } from '../../src/app.setup';
import { AppConfig, buildConfig } from '../../src/config/config';
import { createRootLogger } from '../../src/common/logger';
import { PrismaService } from '../../src/common/prisma.service';
import { REDIS } from '../../src/common/redis';
import { WorkerModule } from '../../src/worker.module';
import type { Redis } from 'ioredis';

export const ADMIN_TOKEN = 'test-admin-token-0123456789abcdef0123456789';

/** Captures JSON log lines for assertions (event logs, redaction). */
export class LogCapture extends Writable {
  lines: Array<Record<string, unknown>> = [];
  raw = '';
  override _write(chunk: Buffer, _enc: string, cb: () => void) {
    const s = chunk.toString();
    this.raw += s;
    for (const l of s.split('\n').filter(Boolean)) {
      try {
        this.lines.push(JSON.parse(l));
      } catch {
        /* ignore */
      }
    }
    cb();
  }
  events(name: string) {
    return this.lines.filter((l) => l.event === name);
  }
}

export function testEnv(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  const s = inject('stack');
  return {
    NODE_ENV: 'test',
    LOG_LEVEL: 'info',
    DATABASE_URL: s.DATABASE_URL,
    REDIS_URL: s.REDIS_URL,
    ADMIN_TOKEN,
    ADMIN_TOKEN_ENABLED: 'true',
    APP_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
    COOKIE_SECURE: 'false',
    MAILPIT_SMTP_HOST: s.SANDBOX_SMTP_HOST,
    MAILPIT_SMTP_PORT: s.SANDBOX_SMTP_PORT,
    SMTP_HOST: s.LIVE_SMTP_HOST,
    SMTP_PORT: s.LIVE_SMTP_PORT,
    SMTP_REQUIRE_TLS: 'false',
    METRICS_PORT: '0',
    DELIVERY_BACKOFF_MS: '200',
    DELIVERY_MAX_ATTEMPTS: '3',
    GLOBAL_RATE_MAX: '1000',
    ...overrides,
  };
}

export interface Stack {
  cfg: AppConfig;
  api: NestExpressApplication;
  worker?: INestApplicationContext;
  http: ReturnType<typeof request>;
  baseUrl: string;
  logs: LogCapture;
  prisma: PrismaService;
  redis: Redis;
  close(): Promise<void>;
}

export async function startStack(
  overrides: Record<string, string | undefined> = {},
  opts: { worker?: boolean; opsServer?: boolean } = {},
): Promise<Stack> {
  const cfg = buildConfig(testEnv(overrides));
  const logs = new LogCapture();
  const logger = createRootLogger({ level: cfg.LOG_LEVEL, service: 'test', destination: logs });
  const api = await NestFactory.create<NestExpressApplication>(ApiModule.forRoot({ cfg, logger, opsServer: opts.opsServer ?? false }), {
    bodyParser: false,
    logger: false,
  });
  configureApp(api, cfg);
  await api.listen(0, '127.0.0.1');
  const baseUrl = `http://127.0.0.1:${(api.getHttpServer().address() as { port: number }).port}`;
  let worker: INestApplicationContext | undefined;
  if (opts.worker !== false) {
    worker = await NestFactory.createApplicationContext(WorkerModule.forRoot({ cfg, logger, opsServer: false, retention: false }), { logger: false });
    await worker.init();
  }
  return {
    cfg,
    api,
    worker,
    http: request(baseUrl),
    baseUrl,
    logs,
    prisma: api.get(PrismaService),
    redis: api.get<Redis>(REDIS),
    async close() {
      await worker?.close();
      await (api as INestApplication).close();
    },
  };
}

/** Clean slate between test files: Redis guardrail keys + gateway unpaused. */
export async function resetState(s: Stack) {
  await s.redis.flushdb();
  await s.prisma.gatewayState.update({ where: { id: 1 }, data: { paused: false, reason: null, pausedBy: null, pausedAt: null } });
}

export async function createKey(s: Stack, body: Record<string, unknown>) {
  const res = await s.http
    .post('/admin/keys')
    .set('Authorization', `Bearer ${ADMIN_TOKEN}`)
    .send({ fromAddress: 'bot@gateway.test', allowedRecipients: ['@example.com'], ...body });
  if (res.status !== 201) throw new Error(`createKey failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body as { key: { id: string; name: string; mode: string }; secret: string };
}

export async function waitFor<T>(fn: () => Promise<T | undefined | null | false>, timeoutMs = 15_000, intervalMs = 150): Promise<T> {
  const end = Date.now() + timeoutMs;
  let last: unknown;
  while (Date.now() < end) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (e) {
      last = e;
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`waitFor timed out${last ? `: ${String(last)}` : ''}`);
}

let uniq = 0;
export const uname = (p: string) => `${p}-${Date.now().toString(36)}-${(uniq++).toString(36)}`;

/** Mailpit REST helpers */
export const mailpit = {
  async search(api: string, query: string) {
    const r = await fetch(`${api}/api/v1/search?query=${encodeURIComponent(query)}`);
    return (await r.json()) as { messages: Array<{ ID: string; Subject: string; To: Array<{ Address: string }> }>; messages_count: number };
  },
  async headers(api: string, id: string) {
    const r = await fetch(`${api}/api/v1/message/${id}/headers`);
    return (await r.json()) as Record<string, string[]>;
  },
  async clear(api: string) {
    await fetch(`${api}/api/v1/messages`, { method: 'DELETE' });
  },
};
