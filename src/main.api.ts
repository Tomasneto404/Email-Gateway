import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { ApiModule } from './api.module';
import { configureApp } from './app.setup';
import { buildConfig } from './config/config';
import { createRootLogger } from './common/logger';

async function bootstrap() {
  const cfg = buildConfig();
  const logger = createRootLogger({ level: cfg.LOG_LEVEL, service: 'api' });
  const app = await NestFactory.create<NestExpressApplication>(ApiModule.forRoot({ cfg, logger }), {
    bodyParser: false,
    bufferLogs: true,
  });
  configureApp(app, cfg);
  await app.listen(cfg.PORT, '0.0.0.0');
  logger.info({ event: 'startup', port: cfg.PORT, metricsPort: cfg.METRICS_PORT }, 'mail-gateway api listening');
}

bootstrap().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
