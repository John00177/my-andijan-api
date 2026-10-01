-- Phase 15B. Additive only: a constant default on session_version (no table
-- rewrite on PostgreSQL 11+) and two nullable audit columns. Existing rows
-- and existing access tokens stay valid (tokens without `sv` are treated as
-- version 0, which every current user has).
-- AlterTable
ALTER TABLE "users" ADD COLUMN     "session_version" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "audit_logs" ADD COLUMN     "actor_role" "UserRole",
ADD COLUMN     "request_id" VARCHAR(64);
