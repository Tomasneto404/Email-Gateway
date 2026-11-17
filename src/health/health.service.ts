// Authored by Tomás Neto (TN 2026)
import { Inject, Injectable } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { Socket } from 'node:net';
import { APP_CONFIG, AppConfig } from '../config/config';
import { PrismaService } from '../common/prisma.service';
import { REDIS } from '../common/redis';

export interface CheckResult {
  status: 'up' | 'down' | 'skipped';
  latencyMs?: number;
  error?: string;
}

export function tcpCheck(host: string, port: number, timeoutMs = 3000): Promise<void> {
  return new Promise((resolve, reject) => {
    const s = new Socket();
    const done = (err?: Error) => {
      s.destroy();
      if (err) reject(err);
      else resolve();
    };
    s.setTimeout(timeoutMs, () => done(new Error(`timeout after ${timeoutMs}ms`)));
    s.once('error', (e) => done(e));
    s.connect(port, host, () => done());
  });
}

async function timed(fn: () => Promise<unknown>): Promise<CheckResult> {
  const t = Date.now();
  try {
    await fn();
    return { status: 'up', latencyMs: Date.now() - t };
  } catch (e) {
    return { status: 'down', latencyMs: Date.now() - t, error: (e as Error).message.slice(0, 200) };
  }
}

@Injectable()
export class HealthService {
  constructor(
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
    private readonly prisma: PrismaService,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  async readiness() {
    const [postgres, redis, smtp] = await Promise.all([
      timed(() => this.prisma.$queryRaw`SELECT 1`),
      timed(() => this.redis.ping()),
      this.cfg.smtpEnabled
        ? timed(() => tcpCheck(this.cfg.SMTP_HOST as string, this.cfg.SMTP_PORT))
        : Promise.resolve<CheckResult>({ status: 'skipped' }),
    ]);
    const checks = { postgres, redis, smtp };
    const ok = Object.values(checks).every((c) => c.status !== 'down');
    return { ok, body: { status: ok ? 'ok' : 'error', checks } };
  }
}
