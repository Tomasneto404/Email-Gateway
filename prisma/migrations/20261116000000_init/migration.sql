CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "KeyMode" AS ENUM ('sandbox', 'live', 'approval');

-- CreateEnum
CREATE TYPE "LiveProvider" AS ENUM ('smtp', 'resend');

-- CreateEnum
CREATE TYPE "DeliveryProvider" AS ENUM ('smtp', 'resend', 'mailpit');

-- CreateEnum
CREATE TYPE "MessageStatus" AS ENUM ('queued', 'pending_approval', 'sent', 'failed', 'rejected', 'captured');

-- CreateEnum
CREATE TYPE "MessageSource" AS ENUM ('api', 'admin_test');

-- CreateTable
CREATE TABLE "api_keys" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "key_hash" TEXT NOT NULL,
    "key_prefix" TEXT NOT NULL,
    "mode" "KeyMode" NOT NULL DEFAULT 'sandbox',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "from_address" TEXT NOT NULL,
    "from_name" TEXT,
    "allow_reply_to" BOOLEAN NOT NULL DEFAULT false,
    "allowed_recipients" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "max_recipients_per_message" INTEGER NOT NULL,
    "max_message_bytes" INTEGER NOT NULL,
    "quota_per_hour" INTEGER NOT NULL,
    "quota_per_day" INTEGER NOT NULL,
    "attachments_allowed" BOOLEAN NOT NULL DEFAULT false,
    "max_attachment_bytes" INTEGER NOT NULL,
    "live_provider" "LiveProvider",
    "last_used_at" TIMESTAMPTZ(3),
    "rotated_at" TIMESTAMPTZ(3),
    "deleted_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "api_keys_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "messages" (
    "id" UUID NOT NULL,
    "api_key_id" UUID NOT NULL,
    "status" "MessageStatus" NOT NULL,
    "delivery_mode" "KeyMode" NOT NULL,
    "provider" "DeliveryProvider",
    "source" "MessageSource" NOT NULL DEFAULT 'api',
    "reject_code" TEXT,
    "reject_reason" TEXT,
    "from_address" TEXT NOT NULL,
    "from_name" TEXT,
    "to" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "cc" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "bcc" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "reply_to" TEXT,
    "subject" TEXT NOT NULL DEFAULT '',
    "text_body" TEXT,
    "html_body" TEXT,
    "body_hash" TEXT NOT NULL,
    "dedup_hash" TEXT,
    "idempotency_key" TEXT,
    "metadata" JSONB,
    "source_ip" TEXT,
    "size_bytes" INTEGER NOT NULL DEFAULT 0,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "last_error" TEXT,
    "provider_response" TEXT,
    "provider_message_id" TEXT,
    "header_message_id" TEXT,
    "delivery_outcome" TEXT,
    "body_purged_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "sent_at" TIMESTAMPTZ(3),

    CONSTRAINT "messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "message_attachments" (
    "id" UUID NOT NULL,
    "message_id" UUID NOT NULL,
    "filename" TEXT NOT NULL,
    "content_type" TEXT NOT NULL,
    "size_bytes" INTEGER NOT NULL,
    "content" BYTEA,

    CONSTRAINT "message_attachments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "message_events" (
    "id" UUID NOT NULL,
    "message_id" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "from_status" "MessageStatus",
    "to_status" "MessageStatus",
    "detail" JSONB,
    "at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "message_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "message_stats_hourly" (
    "bucket" TIMESTAMPTZ(3) NOT NULL,
    "api_key_id" UUID NOT NULL,
    "status" TEXT NOT NULL,
    "reason" TEXT NOT NULL DEFAULT '',
    "count" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "message_stats_hourly_pkey" PRIMARY KEY ("bucket","api_key_id","status","reason")
);

-- CreateTable
CREATE TABLE "gateway_state" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "paused" BOOLEAN NOT NULL DEFAULT false,
    "reason" TEXT,
    "paused_by" TEXT,
    "paused_at" TIMESTAMPTZ(3),
    "breaker_tripped_at" TIMESTAMPTZ(3),
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "gateway_state_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "admin_audit" (
    "id" UUID NOT NULL,
    "at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actor_type" TEXT NOT NULL,
    "actor_id" TEXT,
    "actor_label" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "target_type" TEXT,
    "target_id" TEXT,
    "details" JSONB,
    "ip" TEXT,
    "outcome" TEXT NOT NULL DEFAULT 'success',

    CONSTRAINT "admin_audit_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "api_keys_name_key" ON "api_keys"("name");

-- CreateIndex
CREATE UNIQUE INDEX "api_keys_key_hash_key" ON "api_keys"("key_hash");

-- CreateIndex
CREATE INDEX "messages_created_at_idx" ON "messages"("created_at" DESC);

-- CreateIndex
CREATE INDEX "messages_api_key_id_created_at_idx" ON "messages"("api_key_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "messages_status_created_at_idx" ON "messages"("status", "created_at" DESC);

-- CreateIndex
CREATE INDEX "messages_provider_message_id_idx" ON "messages"("provider_message_id");

-- CreateIndex
CREATE INDEX "messages_to_idx" ON "messages" USING GIN ("to");

-- CreateIndex
CREATE INDEX "messages_subject_trgm_idx" ON "messages" USING GIN ("subject" gin_trgm_ops);

-- CreateIndex
CREATE UNIQUE INDEX "messages_api_key_id_idempotency_key_key" ON "messages"("api_key_id", "idempotency_key");

-- CreateIndex
CREATE INDEX "message_attachments_message_id_idx" ON "message_attachments"("message_id");

-- CreateIndex
CREATE INDEX "message_events_message_id_at_idx" ON "message_events"("message_id", "at");

-- CreateIndex
CREATE INDEX "message_stats_hourly_bucket_idx" ON "message_stats_hourly"("bucket");

-- CreateIndex
CREATE INDEX "admin_audit_at_idx" ON "admin_audit"("at" DESC);

-- CreateIndex
CREATE INDEX "admin_audit_action_at_idx" ON "admin_audit"("action", "at" DESC);

-- CreateIndex
CREATE INDEX "admin_audit_actor_type_actor_id_idx" ON "admin_audit"("actor_type", "actor_id");

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_api_key_id_fkey" FOREIGN KEY ("api_key_id") REFERENCES "api_keys"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "message_attachments" ADD CONSTRAINT "message_attachments_message_id_fkey" FOREIGN KEY ("message_id") REFERENCES "messages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "message_events" ADD CONSTRAINT "message_events_message_id_fkey" FOREIGN KEY ("message_id") REFERENCES "messages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

INSERT INTO "gateway_state" ("id", "paused", "updated_at") VALUES (1, false, now()) ON CONFLICT DO NOTHING;
