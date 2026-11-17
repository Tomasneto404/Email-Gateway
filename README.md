# mail-gateway

A central, containerized mail-sending gateway. Internal applications and LLM agents send email through an HTTP API.
The gateway relays it through the **existing SMTP relay** or **Resend** in live mode, and through **Mailpit** in sandbox mode.

The point of the gateway is to **protect the sender reputation** from misbehaving clients: loops, prompt injection and bugs.
The guardrails are the product:

| Guardrail | What it does |
|---|---|
| Per-key policy | Fixed sender, recipient allow-list (exact address or `@domain`), recipient/size/attachment limits |
| Sandbox by default | New keys only reach Mailpit until an admin promotes them |
| Approval mode | A message waits until an admin approves it |
| Quotas | Per key per hour and per day. Also a global hourly acceptance cap |
| Global rate limit | Paces deliveries to the provider across all workers |
| Dedup | Identical message (key + recipients + subject + body) within 10 min → `DUPLICATE_MESSAGE`. Catches agent loops |
| Idempotency | Same `Idempotency-Key` within 24 h returns the original message |
| Circuit breaker | Repeated provider failures automatically pause the whole gateway |
| Kill switches | Disable a single key, or pause the whole gateway |
| Audit log | Every request after authentication (accepted or rejected), with full body (retention-limited), transitions and provider responses |

---

## Architecture

```
 clients / agents ──HTTP──▶ api ──────▶ BullMQ (Redis) ──▶ worker ──▶ live:    existing SMTP  |  Resend API
   (Bearer mk_...)           │  ▲                            │          sandbox: Mailpit
                             │  └── /webhooks/resend ◀───────┼──────────── Resend delivery events
                             ▼                               ▼
                         PostgreSQL: keys + policies, messages (audit), events, hourly stats, admin_audit
```

- **api** (`dist/main.api.js`) runs `/v1` (public), `/admin` (API + UI auth), `/ui` (admin web UI), `/webhooks/resend`, `/health/*`, `/docs` (Scalar), `/swagger` and `/openapi.json`.
  It enforces the whole policy **synchronously** before anything is queued.
- **worker** (`dist/main.worker.js`) delivers messages, runs retries and the circuit breakers, and runs the daily retention job.
  **Only the worker holds provider credentials** (SMTP password, Resend API key).
- Both run from one image; only the command differs. A one-shot `migrate` service runs `prisma migrate deploy` first.
- Both expose `/metrics` and `/health/*` on an internal port (`METRICS_PORT`, default 9464). Compose does not publish that port.

---

## Quickstart

```bash
cp .env.example .env
# required: POSTGRES_PASSWORD and APP_ENCRYPTION_KEY (encrypts TOTP secrets)
sed -i "s/^POSTGRES_PASSWORD=.*/POSTGRES_PASSWORD=$(openssl rand -hex 16)/; s#^APP_ENCRYPTION_KEY=.*#APP_ENCRYPTION_KEY=$(openssl rand -base64 32)#" .env
docker compose up -d --wait          # postgres, redis, mailpit, migrate, api, worker

# first administrator (prompts for a password)
docker compose exec api node dist/cli.js users:create --email you@company.com --role admin
```

Then open <http://127.0.0.1:3000/ui/> and sign in. Enabling two-factor authentication (account menu → *Two-factor authentication*) is recommended.

- API: <http://127.0.0.1:3000> (`API_BIND`/`API_PORT`). API reference (Scalar): <http://127.0.0.1:3000/docs>; Swagger UI: `/swagger`.
- `./scripts/smoke.sh` runs an end-to-end check of the API through the CLI. It needs no UI login.
- Mailpit UI (dev only, from `compose.override.yml`): <http://127.0.0.1:8025>.
- Production: `docker compose -f docker-compose.yml up -d`. Add `-f compose.secrets.yml` to use Docker secrets (see [Secrets](#secrets)).

> The stack's network uses `MAIL_GATEWAY_SUBNET` (default `10.213.7.0/24`). If it overlaps a route on the host
> (VPN, LAN; check `ip route`), published ports hang and the worker can't reach the SMTP relay. Pick a free range in `.env`.

### Create the first key

Use the CLI inside the api container (no admin API needed):

```bash
docker compose exec api node dist/cli.js keys:create \
  --name report-agent --from reports@yourcompany.com --from-name "Report Agent" \
  --allow @yourcompany.com --allow ops@partner.com --quota-hour 20 --quota-day 100
```

The secret (`mk_sbx_...`) is printed **once**; only its SHA-256 hash is stored. New keys are always in `sandbox` mode.

You can also use the **admin UI** (API keys → New key), which walks you through it and shows the secret once.
For automation there is the admin API with the static token; set `ADMIN_TOKEN_ENABLED=true`, as it's disabled by default:

```bash
curl -sX POST localhost:3000/admin/keys -H "Authorization: Bearer $ADMIN_TOKEN" -H 'Content-Type: application/json' \
  -d '{"name":"report-agent","fromAddress":"reports@yourcompany.com","allowedRecipients":["@yourcompany.com"]}'
```

### Send

```bash
curl -sX POST localhost:3000/v1/send \
  -H "Authorization: Bearer mk_sbx_..." -H 'Content-Type: application/json' -H 'Idempotency-Key: nightly-2026-11-16' \
  -d '{"to":"alice@yourcompany.com","subject":"Nightly report","text":"All green.","metadata":{"job":"nightly"}}'
# → 202 {"id":"01a1…","status":"queued"}

curl -s localhost:3000/v1/messages/01a1… -H "Authorization: Bearer mk_sbx_..."
# → {"status":"captured", "attempts":1, ...}       (sandbox → Mailpit)

curl -s localhost:3000/v1/me -H "Authorization: Bearer mk_sbx_..."
# → policy + {"usage":{"hour":{"used":1,"limit":20,"remaining":19},"day":{...}}}
```

### Promote sandbox → live

In the UI, open **API keys → key → Policy**, set mode to *Live* and save. A warning explains the impact, and you must confirm before it applies. From a shell:

```bash
# admin API
curl -sX PATCH localhost:3000/admin/keys/<id> -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H 'Content-Type: application/json' -d '{"mode":"live"}'
# or CLI
docker compose exec api node dist/cli.js keys:update --name report-agent --mode live
```

- The change takes effect on the next request. It is logged in `admin_audit` as `key.promote_live`.
- The key keeps its `mk_sbx_` prefix, which is only a label from when it was issued; `prefixStale: true` flags the mismatch.
  Rotate the key (`keys:rotate`) to get an `mk_live_` secret.
- `approval` mode also delivers live, but only after an admin approves each message.

---

## Policy reference

| Field | Default | Meaning |
|---|---|---|
| `name` | required | Unique; sent as the `X-Mail-Gateway-Key` header |
| `description` | `""` | |
| `enabled` | `true` | Kill switch. `false` rejects every send with `KEY_DISABLED` |
| `mode` | `sandbox` | `sandbox` → Mailpit only. `live` → real delivery. `approval` → held as `pending_approval` until approved |
| `fromAddress` | required | Fixed sender. Clients cannot override it (`FROM_NOT_ALLOWED`) |
| `fromName` | `null` | Optional display name |
| `allowReplyTo` | `false` | Whether clients may set `replyTo` |
| `allowedRecipients` | `[]` | Exact addresses and/or `@domain` entries (exact domain, no subdomains). **Empty = reject everything.** Every to/cc/bcc must match |
| `maxRecipientsPerMessage` | `DEFAULT_MAX_RECIPIENTS` (10) | Applies to to + cc + bcc |
| `maxMessageBytes` | 1 MB | Subject + text + html + decoded attachments |
| `quotaPerHour` / `quotaPerDay` | 50 / 200 | Accepted messages per UTC hour/day |
| `attachmentsAllowed` | `false` | |
| `maxAttachmentBytes` | 5 MB | Decoded total |
| `liveProvider` | `null` | `smtp` \| `resend` \| `null` (use `LIVE_PROVIDER`) |

Each outgoing message carries `X-Mail-Gateway-Key: <key name>` and `X-Mail-Gateway-Message-Id: <id>`.

### Send request (`POST /v1/send`)

| Field | Notes |
|---|---|
| `to` | string or array; plain addresses only |
| `cc`, `bcc` | optional, same rules |
| `subject` | required, 1–998 chars, no CR/LF |
| `text` / `html` | at least one |
| `replyTo` | only if `allowReplyTo` |
| `attachments` | `[{filename, content (base64), contentType?}]`, only if `attachmentsAllowed` |
| `metadata` | object ≤ 8 KB, stored with the message and never sent |

Header `Idempotency-Key` (optional): the same key within 24 h returns the original message, with `Idempotent-Replayed: true`.

### Errors

Every error has the shape `{"error":{"code","message","details?"}}`. The messages are written so that an LLM agent can tell what to change.

| Code | HTTP | Meaning |
|---|---|---|
| `UNAUTHORIZED` / `INVALID_API_KEY` | 401 | Key missing / wrong / rotated / deleted |
| `AUTH_RATE_LIMITED` | 429 | Too many failed auth attempts from this IP (`Retry-After`) |
| `KEY_DISABLED` | 403 | Kill switch active |
| `GATEWAY_PAUSED` | 503 | Paused by an admin or by the circuit breaker |
| `VALIDATION_FAILED` / `INVALID_JSON` / `REQUEST_TOO_LARGE` | 400/400/413 | Malformed request (includes CR/LF header-injection attempts) |
| `FROM_NOT_ALLOWED` | 400 | Client tried to set the sender |
| `RECIPIENT_NOT_ALLOWED` | 403 | `details.notAllowed`, `details.allowedRecipients` |
| `TOO_MANY_RECIPIENTS` / `REPLY_TO_NOT_ALLOWED` / `ATTACHMENTS_NOT_ALLOWED` | 400 | |
| `MESSAGE_TOO_LARGE` / `ATTACHMENT_TOO_LARGE` | 413 | |
| `DUPLICATE_MESSAGE` | 409 | Same message within the dedup window, probably a loop |
| `IDEMPOTENCY_CONFLICT` | 409 | Same Idempotency-Key still in flight |
| `QUOTA_EXCEEDED` / `GLOBAL_RATE_LIMITED` | 429 | `details.retryAfterSeconds` + `Retry-After` |
| `PROVIDER_UNAVAILABLE` | 503 | The key's live provider is not enabled on this gateway |

Message statuses: `queued`, `pending_approval`, `sent` (live provider accepted it), `captured` (sandbox), `failed`, `rejected`.
With Resend webhooks, `deliveryOutcome` adds `delivered` / `delayed` / `bounced` / `complained`.

---

## LLM agents

- The OpenAPI spec lives at `/openapi.json` (YAML at `/openapi.yaml`), and the committed copy is [`openapi.json`](openapi.json).
- The human-readable reference is **Scalar** at `/docs`, with Swagger UI kept at `/swagger`.
  - Scalar is **self-hosted**: the bundle is copied into `dist/docs-assets` at build time, so there is no CDN.
  - It runs under a strict CSP with no inline scripts.
  - Telemetry, Scalar's web fonts, its AI agent and its request proxy are disabled, so `/docs` never contacts anything outside the gateway.
  - "Test Request" calls the gateway directly (same origin) with the API key you enter; the key is not persisted.
  Operations have stable ids (`sendEmail`, `getMessageStatus`, `getMyPolicy`) and field descriptions written for function-calling.
- Recommended agent loop:
  1. Call `getMyPolicy` once.
  2. Send with an `Idempotency-Key`.
  3. On `4xx`, read `error.message` and change the request; don't retry blindly.
  4. On `429`/`503`, wait for `Retry-After`.
- An MCP endpoint is **deferred**. `SendService.submit()` is the single pipeline every entry point uses, so an MCP tool can be added later without duplicating any policy logic.

---

## Admin UI (`/ui`)

A React single-page app, served by the API on the same origin, so no CORS is involved. Its API client and types are generated from
`openapi.json`, so the UI can't drift from the backend (`npm run gen:api -w ui`).

| Screen | What you can do |
|---|---|
| **Dashboard** | Gateway state, breaker state per provider, SMTP health and pause/resume. Sent/rejected/delivered over time, rejections by reason, top keys, queue depth and pending approvals |
| **API keys** | List with today's/hour's usage against quota. Create wizard that shows the secret once. Key page with policy editor (mode with a live-promotion warning, sender, recipient chips, quotas, limits, attachments, provider), 24 h usage chart, recent messages, rotate, enable/disable, delete and **Send test email** |
| **Messages** | Search by status, key, recipient, subject and date range. Detail drawer with metadata, status timeline, attempts, provider response, headers and text body. The HTML body is shown in a sandboxed iframe |
| **Approvals** | Inbox of `pending_approval` messages with preview, approve/reject (with reason) and bulk actions |
| **Admin users** | Invite a user with roles (one-time link), edit roles, reset 2FA, reset password, disable, delete |
| **Roles** | RBAC: create/edit roles as sets of permissions, map Authentik groups to roles |
| **Activity log** | The `admin_audit` table, filterable by action, actor and outcome, and scoped per user or per API key |
| **Settings** | Effective configuration, read-only and without secrets. Includes the Mailpit link in dev |

**CSV exports.** Messages can be exported by API key or with any list filter, and the activity log in general, per user or per API key:
- From the UI: *Export* buttons on Messages, the key page, Activity log and Admin users.
- From the API: `GET /admin/messages/export.csv?keyId=…` and `GET /admin/audit/export.csv?actorId=…|keyId=…`.

Details:
- Choose `,` or `;` as the separator (`delimiter=semicolon` for Excel in Portuguese and similar locales). Files are UTF-8 with a BOM.
- Message bodies are never exported.
- Cells that could run as spreadsheet formulas are neutralised (CSV injection).
- Exports need `messages:read` / `audit:read`, stream in batches, are capped at `EXPORT_MAX_ROWS`, and are themselves recorded in the activity log.

Keyboard: `⌘K` / `Ctrl+K` opens the command palette, and `g d`, `g k`, `g m`, `g a`, `g u`, `g l`, `g s` jump between screens. Light, dark and system themes are available.

Confirmations:
- Pausing the gateway, rejecting messages and promoting a key to live ask for confirmation.
- Disabling, rotating or deleting a key requires typing its name.
- All of these take effect immediately and are logged in the activity log.

### Authentication and roles

- **Local accounts.**
  - Passwords are hashed with argon2id and must be at least 12 characters.
  - TOTP two-factor is **optional by default**. Each user turns it on from the account menu by scanning a QR code and confirming a code.
    Once on, the code is required at every sign-in, and turning it off requires the current password.
  - Set `TOTP_REQUIRED=true` to make TOTP mandatory for every local user: it is set up at first sign-in and can't be disabled.
  - TOTP secrets are encrypted with AES-256-GCM using `APP_ENCRYPTION_KEY`, and a TOTP code can't be reused.
- **Rate limits.** The account locks after `LOGIN_MAX_FAILURES` failed attempts, and login attempts are also rate-limited per IP.
- **Sessions.**
  - Server-side sessions use a `__Host-mg_session` cookie: httpOnly, Secure, SameSite=Strict.
  - Sessions expire after `SESSION_IDLE_MINUTES` of inactivity, and after `SESSION_TTL_HOURS` at most.
  - The session id is rotated after the second factor.
- **CSRF.** Every state-changing request needs a per-session token in `X-CSRF-Token` **and** a same-origin `Origin`.
  Set `PUBLIC_URL` when the gateway sits behind a TLS-terminating proxy.
- **Authentik SSO** (optional): each role lists the Authentik groups that grant it, edited on the Roles page.
  Users are created on first login, and their roles are re-synced from their groups at every login. See [docs/authentik.md](docs/authentik.md).
- **Roles (RBAC).** Each role is a set of permissions, and a user can hold several roles; they get the union of the permissions.
  - Permissions: `dashboard:read`, `keys:read|create|update|promote|rotate|disable|delete|test_send`, `messages:read|bodies`,
    `approvals:decide`, `gateway:pause`, `users:read|manage`, `roles:manage`, `audit:read`, `settings:read`.
    A role can also hold `<area>:*` or `*`.
  - Built-in roles:

    | Role | Grants |
    |---|---|
    | **Admin** | `*`; can't be changed or deleted |
    | **Operator** | keys (except promote/delete), gateway pause, read-only views |
    | **Approver** | approvals and message bodies |
    | **Auditor** | read-only everything, including bodies and users |
    | **Viewer** | read-only, bodies hidden |
    | **Body reader** | add-on that only grants `messages:bodies` |

    Built-ins can't be deleted or renamed. You can create your own roles in **Roles**.
  - Promoting a key out of sandbox (to live or approval) needs `keys:promote`. Other policy edits need `keys:update`.
  - **Anti-escalation:** nobody can create a role, or grant, revoke or affect permissions, beyond what they hold themselves.
    That includes disabling or deleting a more privileged user.
  - At least one active user with full access (`*`) always remains.
  - Changes to roles and assignments apply on the user's very next request. Every change is audited.
  - The server enforces permissions on every endpoint; the UI only hides what you can't use.
- **Bootstrap.**
  - The first admin is created with the CLI (`users:create`); there is no sign-up page.
  - Other users are invited from the UI with a one-time link, or created with the CLI.
  - When `SYSTEM_MAIL_FROM` is set and SMTP or Resend is enabled, invitations and password resets are **emailed** to the user.
    The worker sends them through the live provider; the API never holds provider credentials. The link is also shown in the UI as a fallback.
    Invite tokens are masked in request logs.
- **Static admin token.** Only for CLI and automation, and **disabled by default** (`ADMIN_TOKEN_ENABLED`).
- **Audit.** Every admin action is written to `admin_audit` and emitted as a structured `admin_action` log event.
  This covers key create/update/promote/rotate/disable/delete, test sends, approve/reject, pause/resume, user changes, enabling/disabling 2FA and login success/failure.

User CLI:

```bash
docker compose exec api node dist/cli.js users:create --email a@b.c [--role Admin --role Viewer …] [--password-stdin]   # default role: Admin
docker compose exec api node dist/cli.js users:list | roles:list | users:reset-2fa --email … | users:reset-access --email … | users:disable --email …
```

### Security headers

- **`/ui`** is served with a strict CSP: `script-src 'self'` (no inline scripts), `frame-ancestors 'none'`, `object-src 'none'`, `base-uri 'none'`, plus `X-Frame-Options: DENY`.
- **HTML message previews** come from `/admin/messages/:id/preview`.
  - The response has its own policy: `default-src 'none'; style-src 'unsafe-inline'; img-src data: cid:; sandbox`.
  - The UI embeds it in an `<iframe sandbox="">`: scripts never run, and the frame has an opaque origin.
  - Remote images are blocked until the user explicitly clicks *Load remote images*.
  - `<meta refresh>` and `<base>` tags are removed.

---

## Operations

Everything below can also be done from the admin UI. Admin API calls need a UI session, or the static token if it's enabled.

| Task | Admin API | CLI (`docker compose exec api node dist/cli.js ...`) |
|---|---|---|
| Pause everything | `POST /admin/gateway/pause {"reason"}` | `gateway:pause --reason "..."` |
| Resume (also resets breakers) | `POST /admin/gateway/resume` | `gateway:resume` |
| Gateway state | `GET /admin/gateway` | `gateway:status` |
| Kill one key | `POST /admin/keys/:id/disable` | `keys:disable --name x` |
| Rotate | `POST /admin/keys/:id/rotate` | `keys:rotate --name x` |
| Approve / reject | `POST /admin/messages/:id/approve` · `/reject {"reason"}` · bulk `POST /admin/messages/approve {"ids":[...]}` | `messages:approve --id` |
| Search audit log | `GET /admin/messages?status=rejected&keyId=&recipient=&subject=&from=&to=&page=&pageSize=&sort=&order=` | |

**Circuit breaker.** There is one breaker per live provider. It trips after `BREAKER_CONSECUTIVE_FAILURES` consecutive
transport-level failures (connection errors, TLS/auth errors, 421), or when the failure rate in `BREAKER_WINDOW_SECONDS`
reaches `BREAKER_FAILURE_RATE` over at least `BREAKER_MIN_SAMPLES` attempts. A trip pauses the gateway: the API answers
`GATEWAY_PAUSED`, and queued jobs stay parked, not lost. The admin audit log records the pause as `system`. Only an admin resume
re-opens the gateway.

**Retries.** Transient errors are retried with exponential backoff (`DELIVERY_BACKOFF_MS`, up to `DELIVERY_MAX_ATTEMPTS`).
These are SMTP 4xx and network errors, or Resend 429/5xx. Permanent errors (5xx, Resend validation) fail immediately.
Every attempt is recorded in the message timeline.

**Retention.** A daily job in the worker (`RETENTION_CRON`, UTC) nulls bodies and attachments older than `AUDIT_BODY_RETENTION_DAYS` (30).
It deletes message rows, events, stats and admin audit entries older than `AUDIT_RECORD_RETENTION_DAYS` (365).

**Logs.** pino JSON on stdout, ready for a SIEM. Every event carries `event`, `keyName`, `messageId`, `outcome` and `reason`.
Events: `message_accepted`, `policy_rejected`, `auth_failed`, `auth_rate_limited`, `delivery_succeeded|retry|failed`,
`provider_event`, `breaker_tripped`, `gateway_paused|resumed`, `admin_action`, `retention_completed`.
API keys, the admin token, cookies, SMTP credentials and message bodies are never logged; bodies exist only in the audit table.

**Metrics** (`:9464/metrics` on api and worker, internal network only):
`mg_messages_total{status,key}`, `mg_rejections_total{reason,key}`, `mg_auth_failures_total{reason}`,
`mg_queue_depth{state}`, `mg_gateway_paused`, `mg_pending_approvals`, `mg_provider_send_duration_seconds{provider,outcome}`,
`mg_circuit_breaker_state{provider}`, `mg_circuit_breaker_trips_total{provider}`, `mg_delivery_outcomes_total{outcome,key}`,
and process metrics (`mg_process_*`).

**Health.**
- `/health/live` is the liveness probe.
- `/health/ready` checks Postgres, Redis and TCP reachability of the SMTP relay. Use it for the HAProxy backend check.

### Behind HAProxy

- Set `TRUST_PROXY` to the HAProxy address(es), for example `TRUST_PROXY=10.0.0.10`. Client IPs (audit log, auth rate limiting) then come from `X-Forwarded-For`.
- Set `PUBLIC_URL` to the URL browsers use (`https://…`). The admin UI's Origin/CSRF check and the SSO redirect URI depend on it.
- Publish the API only on an internal interface (`API_BIND`).

### Resend

See [docs/resend.md](docs/resend.md): enable it with `RESEND_ENABLED=true` and `RESEND_API_KEY`, choose it globally with `LIVE_PROVIDER=resend` or per key with `liveProvider`, then configure the webhook.

### Secrets

Every secret can be passed as `<NAME>_FILE=/run/secrets/<file>`, the Docker secrets convention. Plain env vars still work for development.
`compose.secrets.yml` wires them up:

```bash
mkdir -p secrets && chmod 700 secrets
openssl rand -hex 24 > secrets/postgres_password
echo "postgresql://mailgw:$(cat secrets/postgres_password)@postgres:5432/mailgw" > secrets/database_url
openssl rand -hex 32 > secrets/admin_token
openssl rand -base64 32 > secrets/app_encryption_key
printf '%s' 'smtp-password' > secrets/smtp_password
printf '%s' 're_...' > secrets/resend_api_key; printf '%s' 'whsec_...' > secrets/resend_webhook_secret
docker compose -f docker-compose.yml -f compose.secrets.yml up -d
```

---

## Security notes

- API keys are 256-bit random values, stored only as SHA-256 hashes and checked with a constant-time comparison.
- Failed authentication is rate-limited per client IP.
- CR/LF is rejected in subject, addresses, names and filenames, so headers can't be injected. Only plain addresses are accepted.
- The request body has a hard size limit (`MAX_REQUEST_BYTES`). Unknown fields are rejected.
- The worker uses nodemailer with `disableFileAccess`/`disableUrlAccess`, so attachments can't read files or URLs.
- Containers run as non-root `node` with a read-only root filesystem, `cap_drop: ALL` and `no-new-privileges`. Every service has a healthcheck.
- Admin UI: argon2id + optional (or enforced, `TOTP_REQUIRED`) TOTP, httpOnly/Secure/SameSite=Strict sessions, CSRF token + Origin check, lockout, a strict CSP and sandboxed email previews. See [Admin UI](#admin-ui-ui).
- Resend webhooks are verified with Svix signatures, and stale timestamps are rejected.

---

## Development

```bash
npm ci                         # installs the backend and the ui/ workspace
npm run build                  # prisma generate + tsc
npm test                       # backend unit tests (Redis via testcontainers)
npm run test:integration       # full flow incl. admin auth + Authentik mock: Postgres, Redis, 2× Mailpit (Docker required)
npm run openapi:export         # regenerate openapi.json (a unit test fails on drift) …
npm run gen:api -w ui          # … then regenerate the UI client types
npm run test -w ui             # UI component tests (PolicyEditor)
npm run build -w ui            # UI static build → ui/dist (served at /ui)
npm run dev -w ui              # Vite dev server on :5173, proxying /admin and /v1 to :3000
npm run dev:api / dev:worker   # nest --watch (needs DATABASE_URL, REDIS_URL)

# end-to-end against a running `docker compose up` (dev override):
npx playwright install chromium
npx playwright test -c ui/playwright.config.ts   # CLI admin → login → opt-in 2FA → create key → test send → Messages; preview sandbox; CSP
```

### CI

One workflow, [`.github/workflows/ci.yml`](.github/workflows/ci.yml), runs on the Forgejo runner on every branch push, every `v*` tag and every pull request from a fork (same-repo PRs are already covered by the branch push run):

| Job | What it does |
|---|---|
| **validate** | typecheck (backend + UI), stale OpenAPI client check, backend unit tests (including the OpenAPI drift test), UI component tests, build |
| **integration** | the full integration suite |
| **publish** | after both pass, on `master` and `v*` tags only: builds the images, checks them as the non-root user (`scripts/check-runtime-image.mjs`, `prisma validate`), pushes them |

- Jobs run in `node:22-alpine`. Postgres, Redis and two Mailpits (sandbox + a stand-in for the real SMTP) are job `services:`, reached by service name with no host ports.
- With `MG_TEST_SERVICES=external` and the `TEST_*` variables, the test suite uses those services instead of testcontainers. To reproduce the CI mode locally:

```bash
MG_TEST_SERVICES=external TEST_DATABASE_URL=postgresql://… TEST_REDIS_URL=redis://… \
TEST_SANDBOX_SMTP_HOST=… TEST_SANDBOX_API=http://…:8025 TEST_LIVE_SMTP_HOST=… TEST_LIVE_API=http://…:8025 \
npx vitest run
```

- The Playwright E2E suite is not part of CI; run it against `docker compose up` (see above).

### Docker images

`publish` pushes to `registry.example.com/infra/mail-gateway`:

| Trigger | runtime (api + worker) | migrations |
|---|---|---|
| push to `master` | `:dev` | `:dev-migrate` |
| tag `v1.2.3` | `:1.2.3`, `:1.2`, `:latest` | the same tags with `-migrate` |
| tag `v1.3.0-rc.1` (pre-release) | `:1.3.0-rc.1` only, never `:latest` | `:1.3.0-rc.1-migrate` |

- The runner builds through the host Docker daemon (`container.docker_host: automount` in the runner config).
- It logs in with the `DH_USER` and `DH_PASSWORD` secrets (registry user and password or access token with push rights).

**Deploy from the registry:**

```bash
# .env
MAIL_GATEWAY_IMAGE=registry.example.com/infra/mail-gateway
MAIL_GATEWAY_TAG=1.2.3
# then
docker compose -f docker-compose.yml pull
docker compose -f docker-compose.yml up -d --no-build --wait
```

Layout: `src/send/send.service.ts` holds the single send pipeline and `src/policy/` the pure policy engine plus the Redis guardrails.
The worker and its providers are in `src/worker/`, the admin API in `src/admin/`, and the schema and committed migrations in `prisma/`.
See [`.env.example`](.env.example) for every configuration variable.
