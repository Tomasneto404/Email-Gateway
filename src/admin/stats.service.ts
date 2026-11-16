import { Inject, Injectable } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { APP_CONFIG, AppConfig, liveProvidersEnabled } from '../config/config';
import { GatewayError } from '../common/errors';
import { PrismaService } from '../common/prisma.service';
import { REDIS } from '../common/redis';
import { Prisma } from '../generated/prisma/client';
import { GatewayStateService } from '../gateway-state/gateway-state.service';
import { CheckResult, tcpCheck } from '../health/health.service';
import { QueueService } from '../queue/queue.service';
import { StatsOverviewDto, SystemStateDto } from './admin.dto';

const SERIES_STATUSES = ['accepted', 'sent', 'captured', 'failed', 'rejected'] as const;
type SeriesStatus = (typeof SERIES_STATUSES)[number];

/**
 * Dashboard aggregations. Everything reads `message_stats_hourly` (maintained on each status
 * transition, indexed by bucket), never the `messages` audit table.
 */
@Injectable()
export class StatsService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
    private readonly gateway: GatewayStateService,
    private readonly queues: QueueService,
  ) {}

  async overview(q: { from?: Date; to?: Date; bucket?: 'hour' | 'day'; keyId?: string }): Promise<StatsOverviewDto> {
    const to = q.to ?? new Date();
    const from = q.from ?? new Date(to.getTime() - 24 * 3600_000);
    if (from >= to) throw new GatewayError('VALIDATION_FAILED', '"from" must be before "to".');
    const bucket = q.bucket ?? (to.getTime() - from.getTime() > 3 * 86_400_000 ? 'day' : 'hour');
    const spanMs = bucket === 'hour' ? 3600_000 : 86_400_000;
    if ((to.getTime() - from.getTime()) / spanMs > 2000) throw new GatewayError('VALIDATION_FAILED', 'Range too large for this bucket size.');
    const keyFilter = q.keyId ? Prisma.sql`AND api_key_id = ${q.keyId}::uuid` : Prisma.empty;
    const range = Prisma.sql`bucket >= ${truncate(from, bucket)} AND bucket < ${to}`;

    const [rows, reasons, top, outcomes] = await Promise.all([
      this.prisma.$queryRaw<Array<{ t: Date; status: string; n: bigint }>>`
        SELECT date_trunc(${bucket}, bucket AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' AS t, status, SUM(count)::bigint AS n
        FROM message_stats_hourly WHERE ${range} ${keyFilter}
          AND status IN ('accepted','sent','captured','failed','rejected')
        GROUP BY 1, 2`,
      this.prisma.$queryRaw<Array<{ reason: string; n: bigint }>>`
        SELECT reason, SUM(count)::bigint AS n FROM message_stats_hourly
        WHERE ${range} ${keyFilter} AND status = 'rejected'
        GROUP BY reason ORDER BY n DESC LIMIT 20`,
      this.prisma.$queryRaw<Array<{ key_id: string; name: string; n: bigint }>>`
        SELECT s.api_key_id AS key_id, k.name, SUM(s.count)::bigint AS n
        FROM message_stats_hourly s JOIN api_keys k ON k.id = s.api_key_id
        WHERE ${range} AND s.status = 'accepted' ${q.keyId ? Prisma.sql`AND s.api_key_id = ${q.keyId}::uuid` : Prisma.empty}
        GROUP BY 1, 2 ORDER BY n DESC LIMIT 10`,
      this.prisma.$queryRaw<Array<{ status: string; n: bigint }>>`
        SELECT status, SUM(count)::bigint AS n FROM message_stats_hourly
        WHERE ${range} ${keyFilter} AND status LIKE 'outcome:%'
        GROUP BY status`,
    ]);

    // Zero-filled series.
    const points = new Map<number, Record<SeriesStatus, number>>();
    for (let t = truncate(from, bucket).getTime(); t < to.getTime(); t += spanMs) {
      points.set(t, { accepted: 0, sent: 0, captured: 0, failed: 0, rejected: 0 });
    }
    const totals: Record<SeriesStatus, number> = { accepted: 0, sent: 0, captured: 0, failed: 0, rejected: 0 };
    for (const r of rows) {
      const p = points.get(new Date(r.t).getTime());
      const st = r.status as SeriesStatus;
      if (p) p[st] += Number(r.n);
      totals[st] += Number(r.n);
    }
    return {
      bucket,
      from: from.toISOString(),
      to: to.toISOString(),
      totals,
      series: [...points.entries()].map(([t, v]) => ({ t: new Date(t).toISOString(), ...v })),
      rejectionsByReason: reasons.map((r) => ({ reason: r.reason || 'unknown', count: Number(r.n) })),
      topKeys: top.map((r) => ({ keyId: r.key_id, name: r.name, count: Number(r.n) })),
      outcomes: outcomes.map((r) => ({ outcome: r.status.slice('outcome:'.length), count: Number(r.n) })),
    };
  }

  async system(): Promise<SystemStateDto> {
    const enabled = liveProvidersEnabled(this.cfg);
    const [gateway, depth, pendingApprovals, states, smtpHealth] = await Promise.all([
      this.gateway.get(),
      this.queues.depth(),
      this.prisma.message.count({ where: { status: 'pending_approval' } }),
      this.redis.mget('mg:cb:smtp:state', 'mg:cb:resend:state'),
      this.cfg.smtpEnabled ? this.smtpCheck() : Promise.resolve<CheckResult>({ status: 'skipped' }),
    ]);
    return {
      gateway,
      breakers: (['smtp', 'resend'] as const).map((p, i) => ({ provider: p, enabled: enabled.includes(p), state: states[i] === 'open' ? 'open' : 'closed' })),
      queue: {
        waiting: depth.waiting ?? 0,
        active: depth.active ?? 0,
        delayed: depth.delayed ?? 0,
        failed: depth.failed ?? 0,
        paused: depth.paused ?? 0,
        prioritized: depth.prioritized ?? 0,
      },
      pendingApprovals,
      smtpHealth,
    };
  }

  private async smtpCheck(): Promise<CheckResult> {
    const t = Date.now();
    try {
      await tcpCheck(this.cfg.SMTP_HOST!, this.cfg.SMTP_PORT, 2000);
      return { status: 'up', latencyMs: Date.now() - t };
    } catch (e) {
      return { status: 'down', latencyMs: Date.now() - t, error: (e as Error).message.slice(0, 200) };
    }
  }
}

function truncate(d: Date, bucket: 'hour' | 'day'): Date {
  const x = new Date(d);
  if (bucket === 'day') x.setUTCHours(0, 0, 0, 0);
  else x.setUTCMinutes(0, 0, 0);
  return x;
}
