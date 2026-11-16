import type { NestExpressApplication } from '@nestjs/platform-express';
import cookieParser from 'cookie-parser';
import express, { NextFunction, Request, Response } from 'express';
import helmet from 'helmet';
import { Logger } from 'nestjs-pino';
import { AppConfig, parseTrustProxy } from './config/config';
import { GatewayExceptionFilter } from './common/exception.filter';
import { setupSwagger } from './openapi';
import { scalarRouter } from './scalar-docs';
import { uiRouter } from './ui-static';

/** Shared HTTP setup for main.api.ts and integration tests. */
export function configureApp(app: NestExpressApplication, cfg: AppConfig) {
  app.useLogger(app.get(Logger));
  app.set('trust proxy', parseTrustProxy(cfg.TRUST_PROXY));
  app.disable('x-powered-by');
  app.use(helmet());
  // Raw body for webhook signature verification; must run before the JSON parser.
  app.use('/webhooks/resend', express.raw({ type: '*/*', limit: '1mb' }));
  app.use(express.json({ limit: cfg.MAX_REQUEST_BYTES, strict: true }));
  app.use(cookieParser());
  const ui = uiRouter(cfg);
  if (ui) {
    app.use('/ui', ui);
    app.use((req: Request, res: Response, next: NextFunction) => (req.method === 'GET' && req.path === '/' ? res.redirect(302, '/ui/') : next()));
  }
  app.use(bodyParserErrors);
  app.useGlobalFilters(app.get(GatewayExceptionFilter));
  const docs = scalarRouter();
  if (docs) app.use('/docs', docs);
  setupSwagger(app);
  app.enableShutdownHooks();
}

/** Body-parser failures (oversized / malformed JSON) as machine-readable errors. */
function bodyParserErrors(err: { type?: string; status?: number } | undefined, _req: Request, res: Response, next: NextFunction) {
  if (!err) return next();
  if (err.type === 'entity.too.large') {
    return res.status(413).json({ error: { code: 'REQUEST_TOO_LARGE', message: 'Request body exceeds the gateway limit. Reduce the message or attachment size.' } });
  }
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: { code: 'INVALID_JSON', message: 'Request body is not valid JSON.' } });
  }
  return res.status(err.status ?? 400).json({ error: { code: 'VALIDATION_FAILED', message: 'Unreadable request body.' } });
}
