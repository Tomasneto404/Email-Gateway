import { DynamicModule, Module } from '@nestjs/common';
import { LoggerModule } from 'nestjs-pino';
import { randomUUID } from 'node:crypto';
import { AdminAuthGuard } from './admin/admin-auth.guard';
import { AdminMessagesService } from './admin/admin-messages.service';
import {
  AdminAuditController,
  AdminGatewayController,
  AdminKeysController,
  AdminRolesController,
  AdminMessagesController,
  AdminSettingsController,
  AdminStatsController,
  AdminUsersController,
} from './admin/admin.controllers';
import { StatsService } from './admin/stats.service';
import { ExportService } from './admin/export.service';
import { AccountController, AuthController } from './auth/auth.controller';
import { AuthService } from './auth/auth.service';
import { AuthentikService } from './auth/authentik.service';
import { SecretBox } from './auth/crypto';
import { SessionsService } from './auth/sessions.service';
import { RolesService } from './auth/roles.service';
import { SystemMailService } from './auth/system-mail.service';
import { UsersService } from './auth/users.service';
import { GatewayExceptionFilter } from './common/exception.filter';
import { CoreModule, CoreOptions } from './core.module';
import { HealthController } from './health/health.controller';
import { ApiKeyGuard } from './keys/api-key.guard';
import { AuthLimiterService } from './keys/auth-limiter.service';
import { KeysService } from './keys/keys.service';
import { ApiGauges } from './metrics/gauges';
import { OpsServer } from './metrics/ops-server';
import { DedupService } from './policy/dedup.service';
import { IdempotencyService } from './policy/idempotency.service';
import { QuotaService } from './policy/quota.service';
import { PublicController } from './public-api/public.controller';
import { SendService } from './send/send.service';
import { safeLogPath } from './common/http';
import { ResendWebhookController } from './webhooks/resend-webhook.controller';

export const API_PROVIDERS = [
  KeysService,
  AuthLimiterService,
  ApiKeyGuard,
  QuotaService,
  DedupService,
  IdempotencyService,
  SendService,
  AdminAuthGuard,
  AdminMessagesService,
  GatewayExceptionFilter,
  StatsService,
  ExportService,
  SecretBox,
  SessionsService,
  UsersService,
  RolesService,
  SystemMailService,
  AuthService,
  AuthentikService,
];

@Module({})
export class ApiModule {
  static forRoot(opts: CoreOptions & { opsServer?: boolean }): DynamicModule {
    return {
      module: ApiModule,
      imports: [
        CoreModule.forRoot(opts),
        LoggerModule.forRoot({
          pinoHttp: {
            logger: opts.logger,
            genReqId: (req) => (req.headers['x-request-id'] as string) || randomUUID(),
            autoLogging: { ignore: (req) => (req.url ?? '').startsWith('/health') },
            customLogLevel: (_req, res, err) => (err || res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info'),
            serializers: {
              req: (req: { id: string; method: string; url: string; raw?: { ip?: string } }) => ({
                id: req.id,
                method: req.method,
                path: safeLogPath(String(req.url)),
                ip: req.raw?.ip,
              }),
              res: (res: { statusCode: number }) => ({ statusCode: res.statusCode }),
            },
          },
        }),
      ],
      controllers: [
        PublicController,
        AuthController,
        AccountController,
        AdminKeysController,
        AdminMessagesController,
        AdminGatewayController,
        AdminStatsController,
        AdminUsersController,
        AdminRolesController,
        AdminAuditController,
        AdminSettingsController,
        ResendWebhookController,
        HealthController,
      ],
      providers: [...API_PROVIDERS, ...(opts.opsServer === false ? [] : [OpsServer, ApiGauges])],
    };
  }
}
