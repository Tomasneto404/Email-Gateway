// Authored by Tomás Neto (TN 2026)
import { Inject, Injectable } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { Actor, AdminAuditService } from '../admin/admin-audit.service';
import { EventLogger } from '../common/event-logger';
import { PrismaService } from '../common/prisma.service';
import { REDIS } from '../common/redis';
import { QueueService } from '../queue/queue.service';

const STATE_KEY = 'mg:gw:state';
const BREAKER_KEY_PATTERN = 'mg:cb:*';

export interface GatewayStateView {
  paused: boolean;
  reason: string | null;
  pausedBy: string | null;
  pausedAt: string | null;
}

/** Pause/resume. Postgres is authoritative; Redis caches it for the hot path. */
@Injectable()
export class GatewayStateService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(REDIS) private readonly redis: Redis,
    private readonly queues: QueueService,
    private readonly audit: AdminAuditService,
    private readonly events: EventLogger,
  ) {}

  async get(): Promise<GatewayStateView> {
    const cached = await this.redis.get(STATE_KEY);
    if (cached) return JSON.parse(cached) as GatewayStateView;
    return this.refreshCache();
  }

  async isPaused(): Promise<boolean> {
    return (await this.get()).paused;
  }

  async refreshCache(): Promise<GatewayStateView> {
    const row = await this.prisma.gatewayState.upsert({ where: { id: 1 }, create: { id: 1 }, update: {} });
    const view: GatewayStateView = {
      paused: row.paused,
      reason: row.reason,
      pausedBy: row.pausedBy,
      pausedAt: row.pausedAt?.toISOString() ?? null,
    };
    await this.redis.set(STATE_KEY, JSON.stringify(view), 'EX', 60);
    return view;
  }

  async pause(reason: string, actor: Actor, opts: { breaker?: boolean } = {}): Promise<GatewayStateView> {
    const now = new Date();
    await this.prisma.gatewayState.upsert({
      where: { id: 1 },
      create: { id: 1, paused: true, reason, pausedBy: actor.label, pausedAt: now, breakerTrippedAt: opts.breaker ? now : null },
      update: { paused: true, reason, pausedBy: actor.label, pausedAt: now, ...(opts.breaker ? { breakerTrippedAt: now } : {}) },
    });
    await this.queues.delivery.pause();
    const view = await this.refreshCache();
    await this.audit.record(actor, { action: 'gateway.pause', targetType: 'gateway', details: { reason } });
    this.events.emit('gateway_paused', { reason, actor: actor.label, outcome: 'info' });
    return view;
  }

  async resume(actor: Actor): Promise<GatewayStateView> {
    await this.prisma.gatewayState.upsert({
      where: { id: 1 },
      create: { id: 1, paused: false },
      update: { paused: false, reason: null, pausedBy: null, pausedAt: null },
    });
    await this.resetBreakers();
    await this.queues.delivery.resume();
    const view = await this.refreshCache();
    await this.audit.record(actor, { action: 'gateway.resume', targetType: 'gateway' });
    this.events.emit('gateway_resumed', { actor: actor.label, outcome: 'info' });
    return view;
  }

  private async resetBreakers() {
    let cursor = '0';
    do {
      const [next, keys] = await this.redis.scan(cursor, 'MATCH', BREAKER_KEY_PATTERN, 'COUNT', 100);
      cursor = next;
      if (keys.length) await this.redis.del(...keys);
    } while (cursor !== '0');
  }
}
