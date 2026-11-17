// Authored by Tomás Neto (TN 2026)
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { buildConfig } from './config/config';
import { createRootLogger } from './common/logger';
import { WorkerModule } from './worker.module';

async function bootstrap() {
  const cfg = buildConfig();
  const logger = createRootLogger({ level: cfg.LOG_LEVEL, service: 'worker' });
  const app = await NestFactory.createApplicationContext(WorkerModule.forRoot({ cfg, logger }), { logger: ['error', 'warn'] });
  app.enableShutdownHooks();
  logger.info(
    { event: 'startup', liveProvider: cfg.LIVE_PROVIDER, smtp: cfg.smtpEnabled, resend: cfg.RESEND_ENABLED, metricsPort: cfg.METRICS_PORT },
    'mail-gateway worker started',
  );
}

bootstrap().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
