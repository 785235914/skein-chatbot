-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "SessionStatus" AS ENUM ('ACTIVE', 'RESET');

-- CreateEnum
CREATE TYPE "MessageRole" AS ENUM ('USER', 'ASSISTANT', 'SYSTEM_EVENT');

-- CreateEnum
CREATE TYPE "ExecutionMode" AS ENUM ('QUICK', 'DEEP');

-- CreateEnum
CREATE TYPE "TurnStatus" AS ENUM ('ANSWER', 'PARTIAL', 'NO_EVIDENCE', 'HANDOFF', 'FAILED');

-- CreateTable
CREATE TABLE "sessions" (
    "id" VARCHAR(191) NOT NULL,
    "user_id" VARCHAR(191) NOT NULL,
    "status" "SessionStatus" NOT NULL DEFAULT 'ACTIVE',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "last_active_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "messages" (
    "id" VARCHAR(191) NOT NULL,
    "session_id" VARCHAR(191) NOT NULL,
    "role" "MessageRole" NOT NULL,
    "content" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "compacted_at" TIMESTAMPTZ(3),

    CONSTRAINT "messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "turns" (
    "turn_id" VARCHAR(191) NOT NULL,
    "session_id" VARCHAR(191) NOT NULL,
    "trace_id" VARCHAR(191) NOT NULL,
    "mode" "ExecutionMode" NOT NULL,
    "provider" VARCHAR(191) NOT NULL,
    "provider_key" VARCHAR(191) NOT NULL,
    "status" "TurnStatus" NOT NULL,
    "started_at" TIMESTAMPTZ(3) NOT NULL,
    "completed_at" TIMESTAMPTZ(3),
    "latency_ms" INTEGER NOT NULL,
    "error_code" VARCHAR(191),
    "safe_metadata" JSONB,

    CONSTRAINT "turns_pkey" PRIMARY KEY ("turn_id")
);

-- CreateTable
CREATE TABLE "context_states" (
    "session_id" VARCHAR(191) NOT NULL,
    "revision" INTEGER NOT NULL,
    "value" JSONB NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "context_states_pkey" PRIMARY KEY ("session_id")
);

-- CreateTable
CREATE TABLE "conversation_summaries" (
    "session_id" VARCHAR(191) NOT NULL,
    "value" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "conversation_summaries_pkey" PRIMARY KEY ("session_id")
);

-- CreateTable
CREATE TABLE "provider_bindings" (
    "session_id" VARCHAR(191) NOT NULL,
    "provider" VARCHAR(191) NOT NULL,
    "provider_key" VARCHAR(191) NOT NULL,
    "external_conversation_id" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "provider_bindings_pkey" PRIMARY KEY ("session_id","provider","provider_key")
);

-- CreateTable
CREATE TABLE "runtime_events" (
    "id" UUID NOT NULL,
    "session_id" VARCHAR(191),
    "turn_id" VARCHAR(191),
    "type" VARCHAR(191) NOT NULL,
    "payload" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "runtime_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" UUID NOT NULL,
    "session_id" VARCHAR(191),
    "trace_id" VARCHAR(191),
    "action" VARCHAR(191) NOT NULL,
    "outcome" VARCHAR(64) NOT NULL,
    "metadata" JSONB,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "sessions_user_id_last_active_at_idx" ON "sessions"("user_id", "last_active_at");

-- CreateIndex
CREATE INDEX "messages_session_id_created_at_id_idx" ON "messages"("session_id", "created_at", "id");

-- CreateIndex
CREATE UNIQUE INDEX "turns_trace_id_key" ON "turns"("trace_id");

-- CreateIndex
CREATE INDEX "turns_session_id_started_at_idx" ON "turns"("session_id", "started_at");

-- CreateIndex
CREATE INDEX "runtime_events_session_id_created_at_idx" ON "runtime_events"("session_id", "created_at");

-- CreateIndex
CREATE INDEX "runtime_events_turn_id_created_at_idx" ON "runtime_events"("turn_id", "created_at");

-- CreateIndex
CREATE INDEX "audit_logs_session_id_created_at_idx" ON "audit_logs"("session_id", "created_at");

-- CreateIndex
CREATE INDEX "audit_logs_trace_id_idx" ON "audit_logs"("trace_id");

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "context_states" ADD CONSTRAINT "context_states_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversation_summaries" ADD CONSTRAINT "conversation_summaries_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "provider_bindings" ADD CONSTRAINT "provider_bindings_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "runtime_events" ADD CONSTRAINT "runtime_events_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "sessions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "sessions"("id") ON DELETE SET NULL ON UPDATE CASCADE;
