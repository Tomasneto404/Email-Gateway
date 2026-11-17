// Authored by Tomás Neto (TN 2026)
import { Injectable, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../common/prisma.service';
import { GatewayStateService } from '../gateway-state/gateway-state.service';
import { QueueService } from '../queue/queue.service';
import { CircuitBreakerService } from '../worker/circuit-breaker';
import { MetricsService } from './metrics.service';

/** Gauges collected at scrape time in the API process. */
@Injectable()
export class ApiGauges implements OnModuleInit {
  constructor(
    private readonly metrics: MetricsService,
    private readonly queues: QueueService,
    private readonly gateway: GatewayStateService,
    private readonly prisma: PrismaService,
  ) {}

  onModuleInit() {
    this.metrics.gauge('mg_queue_depth', 'Delivery queue jobs by state', ['state'], async (g) => {
      const counts = await this.queues.depth();
      g.reset();
      for (const [state, n] of Object.entries(counts)) g.set({ state }, n);
    });
    this.metrics.gauge('mg_gateway_paused', '1 when the gateway is paused', [], async (g) => {
      g.set((await this.gateway.isPaused()) ? 1 : 0);
    });
    this.metrics.gauge('mg_pending_approvals', 'Messages waiting for approval', [], async (g) => {
      g.set(await this.prisma.message.count({ where: { status: 'pending_approval' } }));
    });
  }
}

/** Gauges collected at scrape time in the worker process. */
@Injectable()
export class WorkerGauges implements OnModuleInit {
  constructor(
    private readonly metrics: MetricsService,
    private readonly breaker: CircuitBreakerService,
  ) {}

  onModuleInit() {
    this.metrics.gauge('mg_circuit_breaker_state', 'Circuit breaker state per provider (1 = open/tripped)', ['provider'], async (g) => {
      for (const p of ['smtp', 'resend']) g.set({ provider: p }, (await this.breaker.state(p)) === 'open' ? 1 : 0);
    });
  }
}
