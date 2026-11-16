import { Inject, Injectable, OnModuleDestroy } from '@nestjs/common';
import { APP_CONFIG, AppConfig } from '../config/config';
import { DeliveryProvider, ProviderName } from './providers/provider';
import { ResendProvider } from './providers/resend.provider';
import { SmtpProvider } from './providers/smtp.provider';

/** Builds the configured providers. Only the worker process holds provider credentials. */
@Injectable()
export class ProvidersRegistry implements OnModuleDestroy {
  private readonly providers = new Map<ProviderName, DeliveryProvider>();

  constructor(@Inject(APP_CONFIG) cfg: AppConfig) {
    this.providers.set(
      'mailpit',
      new SmtpProvider({
        name: 'mailpit',
        host: cfg.MAILPIT_SMTP_HOST,
        port: cfg.MAILPIT_SMTP_PORT,
        secure: false,
        requireTLS: false,
        rejectUnauthorized: false,
        timeoutMs: 10_000,
      }),
    );
    if (cfg.SMTP_HOST) {
      this.providers.set(
        'smtp',
        new SmtpProvider({
          name: 'smtp',
          host: cfg.SMTP_HOST,
          port: cfg.SMTP_PORT,
          secure: cfg.SMTP_SECURE,
          requireTLS: cfg.SMTP_REQUIRE_TLS,
          rejectUnauthorized: cfg.SMTP_TLS_REJECT_UNAUTHORIZED,
          user: cfg.SMTP_USER,
          password: cfg.SMTP_PASSWORD,
          timeoutMs: cfg.SMTP_TIMEOUT_MS,
        }),
      );
    }
    if (cfg.RESEND_ENABLED) {
      if (!cfg.RESEND_API_KEY) throw new Error('RESEND_ENABLED=true but RESEND_API_KEY (or RESEND_API_KEY_FILE) is not set');
      this.providers.set('resend', new ResendProvider(cfg.RESEND_API_KEY, cfg.RESEND_BASE_URL));
    }
  }

  /** For tests: swap a provider implementation. */
  set(p: DeliveryProvider) {
    this.providers.set(p.name, p);
  }

  get(name: ProviderName): DeliveryProvider | undefined {
    return this.providers.get(name);
  }

  async onModuleDestroy() {
    await Promise.allSettled([...this.providers.values()].map((p) => p.close()));
  }
}
