import { readFileSync } from 'node:fs';
import { z } from 'zod';

/**
 * Docker secrets support: for every `FOO_FILE=/run/secrets/foo` env var, read the file
 * into `FOO` (unless `FOO` is already set). Trailing newline is trimmed.
 */
export function loadSecretFiles(env: NodeJS.ProcessEnv = process.env): void {
  for (const [name, path] of Object.entries(env)) {
    if (!name.endsWith('_FILE') || !path) continue;
    const target = name.slice(0, -'_FILE'.length);
    if (env[target]) continue;
    try {
      env[target] = readFileSync(path, 'utf8').replace(/\r?\n$/, '');
    } catch (err) {
      throw new Error(`Cannot read secret file for ${target} from ${name}=${path}: ${(err as Error).message}`);
    }
  }
}

const bool = (def: boolean) =>
  z
    .enum(['true', 'false', '1', '0', 'yes', 'no'])
    .optional()
    .transform((v) => (v === undefined ? def : ['true', '1', 'yes'].includes(v)));

const int = (def: number, min = 0) => z.coerce.number().int().min(min).default(def);
const optStr = z
  .string()
  .optional()
  .transform((v) => (v === undefined || v.trim() === '' ? undefined : v));

const MB = 1024 * 1024;

export const configSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('production'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  PORT: int(3000, 1),
  METRICS_PORT: int(9464, 0),
  /** Express `trust proxy`: false | true | hop count | comma list of IPs/CIDRs (e.g. HAProxy address). */
  TRUST_PROXY: z.string().default('false'),
  MAX_REQUEST_BYTES: int(15 * MB, 1024),

  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1).default('redis://redis:6379'),

  ADMIN_API_ENABLED: bool(true),
  /** Static admin token is for CLI/automation only and disabled by default. */
  ADMIN_TOKEN_ENABLED: bool(false),
  ADMIN_TOKEN: optStr,

  /** Public base URL of the gateway (used for SSO redirect URIs and Origin checks), e.g. https://mail-gw.internal */
  PUBLIC_URL: optStr,
  UI_ENABLED: bool(true),
  UI_DIST_PATH: optStr,
  /** 32 random bytes, base64. Encrypts TOTP secrets at rest. Generate: openssl rand -base64 32 */
  APP_ENCRYPTION_KEY: optStr,
  COOKIE_SECURE: bool(true),
  SESSION_TTL_HOURS: int(12, 1),
  SESSION_IDLE_MINUTES: int(30, 1),
  LOCAL_LOGIN_ENABLED: bool(true),
  /** false (default): TOTP is optional; each local user may enable it. true: mandatory for every local user. */
  TOTP_REQUIRED: bool(false),
  LOGIN_MAX_FAILURES: int(5, 1),
  LOGIN_LOCKOUT_MINUTES: int(15, 1),
  LOGIN_IP_MAX: int(30, 1),
  LOGIN_IP_WINDOW_SECONDS: int(900, 1),
  INVITE_TTL_HOURS: int(48, 1),

  AUTHENTIK_ENABLED: bool(false),
  /** e.g. https://authentik.example.com/application/o/mail-gateway/ */
  AUTHENTIK_ISSUER: optStr,
  AUTHENTIK_CLIENT_ID: optStr,
  AUTHENTIK_CLIENT_SECRET: optStr,
  AUTHENTIK_SCOPES: z.string().default('openid profile email'),
  AUTHENTIK_GROUPS_CLAIM: z.string().default('groups'),
  /** Allow http issuers (tests/dev only). */
  AUTHENTIK_ALLOW_INSECURE: bool(false),

  DEDUP_WINDOW_SECONDS: int(600),
  IDEMPOTENCY_TTL_SECONDS: int(86_400, 60),

  GLOBAL_RATE_MAX: int(10, 1),
  GLOBAL_RATE_DURATION_MS: int(1000, 1),
  GLOBAL_ACCEPT_PER_HOUR: int(5000),
  WORKER_CONCURRENCY: int(4, 1),

  AUTH_FAIL_MAX: int(20, 1),
  AUTH_FAIL_WINDOW_SECONDS: int(300, 1),

  DELIVERY_MAX_ATTEMPTS: int(6, 1),
  DELIVERY_BACKOFF_MS: int(30_000, 1),

  BREAKER_CONSECUTIVE_FAILURES: int(5, 1),
  BREAKER_FAILURE_RATE: z.coerce.number().min(0).max(1).default(0.5),
  BREAKER_WINDOW_SECONDS: int(300, 1),
  BREAKER_MIN_SAMPLES: int(10, 1),

  AUDIT_BODY_RETENTION_DAYS: int(30, 1),
  AUDIT_RECORD_RETENTION_DAYS: int(365, 1),
  RETENTION_CRON: z.string().default('17 3 * * *'),

  LIVE_PROVIDER: z.enum(['smtp', 'resend']).default('smtp'),

  SMTP_HOST: optStr,
  SMTP_PORT: int(587, 1),
  /** true = implicit TLS (port 465). false = plain connect, then STARTTLS (see SMTP_REQUIRE_TLS). */
  SMTP_SECURE: bool(false),
  SMTP_REQUIRE_TLS: bool(true),
  SMTP_TLS_REJECT_UNAUTHORIZED: bool(true),
  SMTP_USER: optStr,
  SMTP_PASSWORD: optStr,
  SMTP_TIMEOUT_MS: int(30_000, 1000),

  RESEND_ENABLED: bool(false),
  RESEND_API_KEY: optStr,
  RESEND_BASE_URL: optStr,
  RESEND_WEBHOOK_SECRET: optStr,

  /** Sender of system emails (admin invites). Unset = invites are shown as a link only. */
  SYSTEM_MAIL_FROM: optStr,
  SYSTEM_MAIL_FROM_NAME: z.string().default('mail-gateway'),

  MAILPIT_SMTP_HOST: z.string().default('mailpit'),
  MAILPIT_SMTP_PORT: int(1025, 1),
  MAILPIT_UI_URL: optStr,

  /** Maximum rows per CSV export (protects the database; narrow the filters for more). */
  EXPORT_MAX_ROWS: int(100_000, 1),

  DEFAULT_QUOTA_PER_HOUR: int(50),
  DEFAULT_QUOTA_PER_DAY: int(200),
  DEFAULT_MAX_RECIPIENTS: int(10, 1),
  DEFAULT_MAX_MESSAGE_BYTES: int(1 * MB, 1),
  DEFAULT_MAX_ATTACHMENT_BYTES: int(5 * MB, 0),
});

export type AppConfig = z.infer<typeof configSchema> & {
  smtpEnabled: boolean;
};

export const APP_CONFIG = Symbol('APP_CONFIG');

export function buildConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  loadSecretFiles(env);
  const parsed = configSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid configuration:\n${issues}`);
  }
  const cfg = parsed.data;
  if (cfg.ADMIN_TOKEN && cfg.ADMIN_TOKEN.length < 32) {
    throw new Error('Invalid configuration:\n  - ADMIN_TOKEN: must be at least 32 characters');
  }
  const problems: string[] = [];
  if (cfg.APP_ENCRYPTION_KEY && Buffer.from(cfg.APP_ENCRYPTION_KEY, 'base64').length !== 32) {
    problems.push('APP_ENCRYPTION_KEY: must be 32 bytes, base64-encoded (openssl rand -base64 32)');
  }
  if (cfg.AUTHENTIK_ENABLED) {
    for (const k of ['AUTHENTIK_ISSUER', 'AUTHENTIK_CLIENT_ID', 'AUTHENTIK_CLIENT_SECRET', 'PUBLIC_URL'] as const) {
      if (!cfg[k]) problems.push(`${k}: required when AUTHENTIK_ENABLED=true`);
    }
  }
  if (cfg.SYSTEM_MAIL_FROM && !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(cfg.SYSTEM_MAIL_FROM)) {
    problems.push('SYSTEM_MAIL_FROM: must be a plain email address');
  }
  if (problems.length) throw new Error(`Invalid configuration:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
  return { ...cfg, smtpEnabled: !!cfg.SMTP_HOST };
}

/** Express trust proxy value from the TRUST_PROXY string. */
export function parseTrustProxy(v: string): boolean | number | string[] {
  const t = v.trim();
  if (t === 'false' || t === '') return false;
  if (t === 'true') return true;
  if (/^\d+$/.test(t)) return Number(t);
  return t.split(',').map((s) => s.trim()).filter(Boolean);
}

/** System emails need a sender address and an enabled live provider (SMTP or Resend). */
export function systemMailProvider(cfg: AppConfig): 'smtp' | 'resend' | null {
  if (!cfg.SYSTEM_MAIL_FROM) return null;
  const enabled = liveProvidersEnabled(cfg);
  if (enabled.includes(cfg.LIVE_PROVIDER)) return cfg.LIVE_PROVIDER;
  return enabled[0] ?? null;
}

export function liveProvidersEnabled(cfg: AppConfig): Array<'smtp' | 'resend'> {
  const out: Array<'smtp' | 'resend'> = [];
  if (cfg.smtpEnabled) out.push('smtp');
  if (cfg.RESEND_ENABLED) out.push('resend');
  return out;
}
