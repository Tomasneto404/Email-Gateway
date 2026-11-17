// Authored by Tomás Neto (TN 2026)
import { Injectable } from '@nestjs/common';
import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client';

/** Per-process Prometheus registry. Exposed on the internal METRICS_PORT. */
@Injectable()
export class MetricsService {
  readonly registry = new Registry();

  readonly messages = new Counter({
    name: 'mg_messages_total',
    help: 'Messages by resulting status and key',
    labelNames: ['status', 'key'] as const,
    registers: [this.registry],
  });
  readonly rejections = new Counter({
    name: 'mg_rejections_total',
    help: 'Policy/guardrail rejections by reason and key',
    labelNames: ['reason', 'key'] as const,
    registers: [this.registry],
  });
  readonly authFailures = new Counter({
    name: 'mg_auth_failures_total',
    help: 'Failed authentication attempts',
    labelNames: ['reason'] as const,
    registers: [this.registry],
  });
  readonly providerLatency = new Histogram({
    name: 'mg_provider_send_duration_seconds',
    help: 'Latency of provider send calls',
    labelNames: ['provider', 'outcome'] as const,
    buckets: [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 30],
    registers: [this.registry],
  });
  readonly deliveryOutcomes = new Counter({
    name: 'mg_delivery_outcomes_total',
    help: 'Provider-reported delivery outcomes (Resend webhooks)',
    labelNames: ['outcome', 'key'] as const,
    registers: [this.registry],
  });
  readonly breakerTrips = new Counter({
    name: 'mg_circuit_breaker_trips_total',
    help: 'Circuit breaker trips',
    labelNames: ['provider'] as const,
    registers: [this.registry],
  });

  constructor() {
    collectDefaultMetrics({ register: this.registry, prefix: 'mg_process_' });
  }

  gauge(name: string, help: string, labelNames: string[], collect: (g: Gauge) => Promise<void>) {
    const existing = this.registry.getSingleMetric(name);
    if (existing) return existing as Gauge;
    return new Gauge({
      name,
      help,
      labelNames,
      registers: [this.registry],
      async collect() {
        try {
          await collect(this);
        } catch {
          // scrape must not fail because a dependency is down
        }
      },
    });
  }
}
