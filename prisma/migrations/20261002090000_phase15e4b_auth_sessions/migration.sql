-- Phase 15E.4b — EXPAND step of expand -> backfill -> contract.
--
-- Purely additive, so the backend that is still serving while the new one
-- boots (Railway runs `prisma migrate deploy` before the new container takes
-- traffic) keeps working unchanged:
--   * a new table and a new enum the old code never reads;
--   * three NULLABLE columns on refresh_tokens (the old code's INSERTs omit
--     them; its SELECT/UPDATEs ignore them);
--   * refresh_tokens.parent_id UNIQUE — every existing row is NULL, and
--     NULLs never collide.
-- Nothing is made NOT NULL and nothing is dropped; that is 15E.4e (contract),
-- a separate deploy once no pre-15E.4b code can be running.
--
-- CreateEnum
CREATE TYPE "SessionRevokedReason" AS ENUM ('LOGOUT', 'PASSWORD_RESET', 'SUSPENDED', 'REUSE_DETECTED', 'LEGACY_MIGRATION');

-- AlterTable
ALTER TABLE "refresh_tokens" ADD COLUMN     "parent_id" INTEGER,
ADD COLUMN     "rotated_at" TIMESTAMP(3),
ADD COLUMN     "session_id" INTEGER;

-- CreateTable
CREATE TABLE "auth_sessions" (
    "id" SERIAL NOT NULL,
    "user_id" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "absolute_expires_at" TIMESTAMP(3) NOT NULL,
    "revoked_at" TIMESTAMP(3),
    "revoked_reason" "SessionRevokedReason",
    "last_used_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "user_agent" VARCHAR(500),
    "ip_address" VARCHAR(45),

    CONSTRAINT "auth_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "auth_sessions_user_id_idx" ON "auth_sessions"("user_id");

-- CreateIndex
CREATE INDEX "auth_sessions_user_id_revoked_at_idx" ON "auth_sessions"("user_id", "revoked_at");

-- CreateIndex
CREATE UNIQUE INDEX "refresh_tokens_parent_id_key" ON "refresh_tokens"("parent_id");

-- CreateIndex
CREATE INDEX "refresh_tokens_session_id_idx" ON "refresh_tokens"("session_id");

-- AddForeignKey
ALTER TABLE "auth_sessions" ADD CONSTRAINT "auth_sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "auth_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_parent_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "refresh_tokens"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- Backfill: every ACTIVE legacy token (not revoked, not expired, no session)
-- gets its own session, so nobody is signed out by this deploy. The token's
-- created_at is the best available sign-in time (the pre-15E.4b code kept no
-- chain). The absolute expiry is created_at + 90 days, but never earlier than
-- the token's own expiry, so the backfill cannot shorten a live session.
-- Revoked and expired legacy rows keep session_id NULL: they are unusable
-- either way and are dealt with in 15E.4e.
--
-- Session ids are drawn from the sequence up front so each token can be
-- linked to the session made for it in one statement. Tokens written by the
-- old code after this point (session_id NULL) are attached on first use by
-- the application (see src/auth/refresh-sessions.ts).
WITH legacy AS (
    SELECT
        t."id" AS "token_id",
        nextval(pg_get_serial_sequence('"auth_sessions"', 'id')) AS "session_id",
        t."user_id",
        t."created_at",
        GREATEST(t."created_at" + INTERVAL '90 days', t."expires_at") AS "absolute_expires_at"
    FROM "refresh_tokens" t
    WHERE t."session_id" IS NULL
      AND t."revoked_at" IS NULL
      AND t."expires_at" > CURRENT_TIMESTAMP
),
created AS (
    INSERT INTO "auth_sessions" ("id", "user_id", "created_at", "absolute_expires_at", "last_used_at")
    SELECT "session_id", "user_id", "created_at", "absolute_expires_at", "created_at"
    FROM legacy
    RETURNING "id"
)
UPDATE "refresh_tokens" r
SET "session_id" = legacy."session_id"
FROM legacy
WHERE r."id" = legacy."token_id";
