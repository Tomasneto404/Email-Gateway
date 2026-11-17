#!/usr/bin/env bash
# Authored by Tomás Neto (TN 2026)
# End-to-end smoke test against a running `docker compose up` stack (dev override loaded).
# Creates a sandbox key with the CLI, sends a message, checks Mailpit and the guardrails.
set -euo pipefail
API=${API:-http://127.0.0.1:${API_PORT:-3000}}
MAILPIT=${MAILPIT:-http://127.0.0.1:${MAILPIT_UI_PORT:-8025}}
NAME="smoke-$(date +%s)"
pass() { printf '  \033[32m✔\033[0m %s\n' "$1"; }
fail() { printf '  \033[31m✘\033[0m %s\n' "$1"; exit 1; }

echo "→ health"
curl -fsS "$API/health/live" >/dev/null && pass "api live"
curl -fsS "$API/health/ready" >/dev/null && pass "api ready"
docker compose exec -T worker wget -qO- http://127.0.0.1:9464/health/ready >/dev/null && pass "worker ready"

echo "→ create sandbox key via CLI"
OUT=$(docker compose exec -T api node dist/cli.js keys:create --name "$NAME" --from bot@gateway.local --allow @example.com --quota-hour 3)
KEY=$(echo "$OUT" | grep -oE 'mk_sbx_[0-9A-Za-z]{43}' | head -1)
[ -n "$KEY" ] && pass "key issued (${KEY:0:12}…)" || fail "no key in CLI output"

echo "→ send"
SUBJ="smoke $NAME"
RES=$(curl -sS -X POST "$API/v1/send" -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
  -d "{\"to\":\"alice@example.com\",\"subject\":\"$SUBJ\",\"text\":\"hello from smoke\"}")
ID=$(echo "$RES" | sed -n 's/.*"id":"\([^"]*\)".*/\1/p')
[ -n "$ID" ] && pass "accepted $ID" || fail "send failed: $RES"

for _ in $(seq 1 30); do
  ST=$(curl -sS "$API/v1/messages/$ID" -H "Authorization: Bearer $KEY" | sed -n 's/.*"status":"\([^"]*\)".*/\1/p')
  [ "$ST" = captured ] && break; sleep 0.5
done
[ "$ST" = captured ] && pass "status=captured" || fail "status=$ST"
curl -sS "$MAILPIT/api/v1/search?query=$(printf 'subject:"%s"' "$SUBJ" | jq -sRr @uri)" | grep -q "\"messages_count\":1" \
  && pass "message in Mailpit" || fail "message not found in Mailpit"

echo "→ guardrails"
code() { curl -sS -X POST "$API/v1/send" -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' -d "$1" | sed -n 's/.*"code":"\([^"]*\)".*/\1/p'; }
[ "$(code '{"to":"x@evil.io","subject":"a","text":"b"}')" = RECIPIENT_NOT_ALLOWED ] && pass RECIPIENT_NOT_ALLOWED || fail RECIPIENT_NOT_ALLOWED
[ "$(code "{\"to\":\"alice@example.com\",\"subject\":\"$SUBJ\",\"text\":\"hello from smoke\"}")" = DUPLICATE_MESSAGE ] && pass DUPLICATE_MESSAGE || fail DUPLICATE_MESSAGE
code '{"to":"a@example.com","subject":"q2","text":"x"}' >/dev/null; code '{"to":"a@example.com","subject":"q3","text":"x"}' >/dev/null
[ "$(code '{"to":"a@example.com","subject":"q4","text":"x"}')" = QUOTA_EXCEEDED ] && pass QUOTA_EXCEEDED || fail QUOTA_EXCEEDED
docker compose logs api --since 2m | grep -q '"event":"policy_rejected"' && pass "policy_rejected events logged" || fail "no policy_rejected log"

echo "→ pause / resume"
docker compose exec -T api node dist/cli.js gateway:pause --reason smoke >/dev/null
[ "$(code '{"to":"a@example.com","subject":"paused","text":"x"}')" = GATEWAY_PAUSED ] && pass GATEWAY_PAUSED || fail GATEWAY_PAUSED
docker compose exec -T api node dist/cli.js gateway:resume >/dev/null && pass "resumed"
docker compose exec -T api node dist/cli.js keys:delete --name "$NAME" >/dev/null && pass "cleanup"
echo "smoke OK"
