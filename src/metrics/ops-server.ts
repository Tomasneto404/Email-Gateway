// Authored by Tomás Neto (TN 2026)
import { Inject, Injectable, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { createServer, Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { APP_CONFIG, AppConfig } from '../config/config';
import { HealthService } from '../health/health.service';
import { MetricsService } from './metrics.service';

export const OPS_SERVER_ENABLED = Symbol('OPS_SERVER_ENABLED');

/**
 * Internal-only HTTP listener (METRICS_PORT): /metrics, /health/live, /health/ready.
 * Not published in docker-compose; scrape it from the internal network.
 */
@Injectable()
export class OpsServer implements OnApplicationBootstrap, OnApplicationShutdown {
  private server?: Server;
  port?: number;

  constructor(
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
    private readonly metrics: MetricsService,
    private readonly health: HealthService,
  ) {}

  async onApplicationBootstrap() {
    this.server = createServer(async (req, res) => {
      try {
        if (req.method !== 'GET') {
          res.writeHead(405).end();
          return;
        }
        if (req.url === '/metrics') {
          const body = await this.metrics.registry.metrics();
          res.writeHead(200, { 'content-type': this.metrics.registry.contentType }).end(body);
        } else if (req.url === '/health/live') {
          res.writeHead(200, { 'content-type': 'application/json' }).end('{"status":"ok"}');
        } else if (req.url === '/health/ready') {
          const r = await this.health.readiness();
          res.writeHead(r.ok ? 200 : 503, { 'content-type': 'application/json' }).end(JSON.stringify(r.body));
        } else {
          res.writeHead(404).end();
        }
      } catch {
        res.writeHead(500).end();
      }
    });
    await new Promise<void>((resolve) => this.server!.listen(this.cfg.METRICS_PORT, resolve));
    this.port = (this.server.address() as AddressInfo).port;
  }

  async onApplicationShutdown() {
    await new Promise<void>((r) => (this.server ? this.server.close(() => r()) : r()));
  }
}
