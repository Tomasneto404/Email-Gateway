<!-- Authored by Tomás Neto (TN 2026) -->
# Resend provider

mail-gateway can deliver live mail through [Resend](https://resend.com) as well as, or instead of, the existing SMTP relay.
Sandbox keys always go to Mailpit, whatever provider is configured.

## Enable

1. In Resend, verify the sending domain(s) used by your keys' `fromAddress`.
2. Create an API key with **Sending access** only.
3. Configure the gateway:

```env
RESEND_ENABLED=true
RESEND_API_KEY=re_...            # worker only; prefer RESEND_API_KEY_FILE=/run/secrets/resend_api_key
LIVE_PROVIDER=resend             # optional: make Resend the default for live/approval keys
```

To use Resend for some keys only, keep `LIVE_PROVIDER=smtp` and set `liveProvider: "resend"` on those keys
(admin API `PATCH /admin/keys/:id`, or the CLI flag `--provider resend`). `liveProvider: null` means "use the default".

If a key points at a provider that is not enabled, sends are rejected with `PROVIDER_UNAVAILABLE` and nothing is queued.

## How messages are sent

- Every policy rule still applies. The gateway checks everything before Resend sees the message.
- The gateway passes its own message id as Resend's `Idempotency-Key`, so BullMQ retries can never produce duplicates.
- Every email gets the `X-Mail-Gateway-Key` and `X-Mail-Gateway-Message-Id` headers and our own `Message-ID`.
  It also gets the Resend tags `gateway_key` and `gateway_message_id`.
- How errors are handled:

  | Resend response | Handling | Counts toward the circuit breaker's consecutive failures |
  |---|---|---|
  | `429`, `5xx`, network errors | transient: retried with backoff | yes |
  | `validation_error` and other 4xx | permanent: `failed` | no |
  | `invalid_api_key`, `invalid_from_address`, quota exceeded | permanent: `failed` | yes |

- Resend has its own circuit breaker (`mg:cb:resend:*`). When it trips, the whole gateway pauses until an admin resumes it.

## Webhooks (bounces and complaints)

1. In Resend → Webhooks, add the endpoint `https://<gateway-host>/webhooks/resend`.
   Subscribe to `email.delivered`, `email.delivery_delayed`, `email.bounced` and `email.complained`.
2. Copy the signing secret (`whsec_...`) into `RESEND_WEBHOOK_SECRET`, or `RESEND_WEBHOOK_SECRET_FILE`, on the **api** service.
3. Expose `/webhooks/resend` through HAProxy. It is the only route that has to be reachable from the internet.

What happens when an event arrives:

- The gateway checks the Svix signature and rejects stale timestamps. An invalid signature gets `401` and an `auth_failed` log event.
- It finds the message by the Resend email id and adds the event to the message's timeline.
- It updates `deliveryOutcome`. A bounce or complaint is never overwritten by a later `delivered`.
- It counts the event in `mg_delivery_outcomes_total{outcome,key}`.

Without `RESEND_WEBHOOK_SECRET`, the endpoint answers `404`.
