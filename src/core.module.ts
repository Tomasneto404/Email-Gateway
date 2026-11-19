// Authored by Tomás Neto (TN 2026)
import { DynamicModule, Global, Module } from '@nestjs/common';
import type { Logger } from 'pino';
import { AdminAuditService } from './admin/admin-audit.service';
import { AlertsService } from './alerts/alerts.service';
import { AuditChainService } from './admin/audit-chain.service';
import { SecretBox } from './auth/crypto';
import { BodyCrypto } from './common/body-crypto';
import { APP_CONFIG, AppConfig } from './config/config';
import { EventLogger } from './common/event-logger';
import { ROOT_LOGGER } from './common/logger';
import { PrismaService } from './common/prisma.service';
import { RedisHolder, redisProvider } from './common/redis';
import { GatewayStateService } from './gateway-state/gateway-state.service';
import { HealthService } from './health/health.service';
import { MessagesRepository } from './messages/messages.repository';
import { MetricsService } from './metrics/metrics.service';
import { QueueService } from './queue/queue.service';

export interface CoreOptions {
  cfg: AppConfig;
  logger: Logger;
}

const SHARED = [
  PrismaService,
  RedisHolder,
  redisProvider,
  QueueService,
  MetricsService,
  EventLogger,
  AdminAuditService,
  GatewayStateService,
  MessagesRepository,
  HealthService,
  SecretBox,
  BodyCrypto,
  AuditChainService,
  AlertsService,
];

/** Shared infrastructure for api, worker and CLI. */
@Global()
@Module({})
export class CoreModule {
  static forRoot(opts: CoreOptions): DynamicModule {
    return {
      module: CoreModule,
      providers: [{ provide: APP_CONFIG, useValue: opts.cfg }, { provide: ROOT_LOGGER, useValue: opts.logger }, ...SHARED],
      exports: [APP_CONFIG, ROOT_LOGGER, ...SHARED],
    };
  }
}
