-- Authored by Tomás Neto (TN 2026)
-- Hardening: key access controls, content guardrails, templates, warm-up, alerts, passkeys, tamper-evident audit.

-- AlterTable
ALTER TABLE "api_keys" ADD COLUMN     "allowed_attachment_types" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "allowed_ips" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "allowed_link_domains" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "allowed_templates" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "block_secrets" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "expires_at" TIMESTAMPTZ(3),
ADD COLUMN     "live_since" TIMESTAMPTZ(3),
ADD COLUMN     "max_links" INTEGER,
ADD COLUMN     "prev_key_expires_at" TIMESTAMPTZ(3),
ADD COLUMN     "prev_key_hash" TEXT,
ADD COLUMN     "scan_attachments" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "templates_only" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "warmup" BOOLEAN NOT NULL DEFAULT true;
-- AlterTable
ALTER TABLE "messages" ADD COLUMN     "template_name" TEXT;
-- AlterTable
-- CreateTable
CREATE TABLE "audit_chain_state" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "anchor_seq" BIGINT,
    "anchor_hash" TEXT,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "audit_chain_state_pkey" PRIMARY KEY ("id")
);
-- CreateTable
CREATE TABLE "templates" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "subject" TEXT NOT NULL,
    "text" TEXT,
    "html" TEXT,
    "variables" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "templates_pkey" PRIMARY KEY ("id")
);
-- CreateTable
CREATE TABLE "alert_channels" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "target_enc" TEXT NOT NULL,
    "secret_enc" TEXT,
    "events" TEXT[] DEFAULT ARRAY['*']::TEXT[],
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "last_delivered_at" TIMESTAMPTZ(3),
    "last_error" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "alert_channels_pkey" PRIMARY KEY ("id")
);
-- CreateTable
CREATE TABLE "alert_events" (
    "id" UUID NOT NULL,
    "at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "type" TEXT NOT NULL,
    "severity" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "detail" JSONB,
    "delivered_to" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "failed_to" TEXT[] DEFAULT ARRAY[]::TEXT[],
    CONSTRAINT "alert_events_pkey" PRIMARY KEY ("id")
);
-- CreateTable
CREATE TABLE "admin_passkeys" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "credential_id" TEXT NOT NULL,
    "public_key" BYTEA NOT NULL,
    "counter" BIGINT NOT NULL DEFAULT 0,
    "transports" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "name" TEXT NOT NULL DEFAULT 'Passkey',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_used_at" TIMESTAMPTZ(3),
    CONSTRAINT "admin_passkeys_pkey" PRIMARY KEY ("id")
);
-- CreateIndex
CREATE UNIQUE INDEX "templates_name_key" ON "templates"("name");
-- CreateIndex
CREATE UNIQUE INDEX "alert_channels_name_key" ON "alert_channels"("name");
-- CreateIndex
CREATE INDEX "alert_events_at_idx" ON "alert_events"("at" DESC);
-- CreateIndex
CREATE UNIQUE INDEX "admin_passkeys_credential_id_key" ON "admin_passkeys"("credential_id");
-- CreateIndex
CREATE INDEX "admin_passkeys_user_id_idx" ON "admin_passkeys"("user_id");
-- CreateIndex
CREATE UNIQUE INDEX "api_keys_prev_key_hash_key" ON "api_keys"("prev_key_hash");
-- Audit hash chain. Existing rows are numbered in the order they happened (at, id); the API
-- computes their hashes on startup (the HMAC key is not available to SQL).
CREATE SEQUENCE "admin_audit_seq_seq" AS BIGINT;
ALTER TABLE "admin_audit" ADD COLUMN "seq" BIGINT, ADD COLUMN "prev_hash" TEXT, ADD COLUMN "hash" TEXT;
UPDATE "admin_audit" a SET "seq" = o.rn
FROM (SELECT "id", row_number() OVER (ORDER BY "at", "id") AS rn FROM "admin_audit") o
WHERE a."id" = o."id";
SELECT setval('"admin_audit_seq_seq"', COALESCE((SELECT max("seq") FROM "admin_audit"), 0) + 1, false);
ALTER TABLE "admin_audit" ALTER COLUMN "seq" SET DEFAULT nextval('"admin_audit_seq_seq"'), ALTER COLUMN "seq" SET NOT NULL;
ALTER SEQUENCE "admin_audit_seq_seq" OWNED BY "admin_audit"."seq";
CREATE UNIQUE INDEX "admin_audit_seq_key" ON "admin_audit"("seq");

-- Built-in roles get the new areas: templates (Operator manages, read-only roles read) and alerts.
UPDATE "roles" SET "permissions" = "permissions" || ARRAY['templates:read','templates:manage','alerts:read','alerts:manage']
WHERE "builtin" AND "name" = 'Operator';
UPDATE "roles" SET "permissions" = "permissions" || ARRAY['templates:read','alerts:read']
WHERE "builtin" AND "name" IN ('Auditor', 'Viewer');
-- AddForeignKey
ALTER TABLE "admin_passkeys" ADD CONSTRAINT "admin_passkeys_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "admin_users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
