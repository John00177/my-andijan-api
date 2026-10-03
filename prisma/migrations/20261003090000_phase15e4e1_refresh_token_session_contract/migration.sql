-- Phase 15E.4e.1 — CONTRACT step of expand -> backfill -> contract
-- (expand + backfill: 20261002090000_phase15e4b_auth_sessions).
--
-- Every refresh token belongs to exactly one AuthSession: refresh_tokens.session_id
-- becomes NOT NULL. Session-less ("legacy") rows can only have been written by
-- the pre-15E.4b release; none has served since 2026-10-02 10:27:40 UTC.
--
-- Prisma applies this file as ONE transaction (verified against PostgreSQL 16:
-- a failure anywhere rolls every statement back, and the migration is recorded
-- as failed). So either all of it happens, or nothing does.
--
-- Rolling deploy: the previous release (06d6de9) keeps serving while this runs.
-- It never writes a NULL session_id, and it handles NOT NULL rows unchanged.

-- Serialize with every reader and writer of refresh_tokens for the length of
-- this transaction, taken up front (never upgraded later, so it cannot
-- deadlock against a transaction that already read the table). An application
-- transaction is short; if one is still holding the table after 30 s, fail
-- (atomically) rather than keep every sign-in and refresh queued behind us.
SET LOCAL lock_timeout = '30s';
LOCK TABLE "refresh_tokens" IN ACCESS EXCLUSIVE MODE;

-- 1. Still-LIVE session-less tokens are never discarded: each gets its own
--    session, by exactly the rule of the 15E.4b backfill — the token's
--    created_at as the sign-in time, absolute expiry created_at + 90 days but
--    never earlier than the token's own expiry. Nobody is signed out.
--    Timestamps are compared in UTC, the zone Prisma writes them in.
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
      AND t."expires_at" > (CURRENT_TIMESTAMP AT TIME ZONE 'UTC')
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
WHERE r."id" = legacy."token_id"
  AND r."session_id" IS NULL;

-- 2. Every remaining session-less row must be DEAD — revoked or expired —
--    and can never authenticate again. Deleted (owner decision D1). The
--    predicate names "dead" explicitly: a live row is never deleted here.
--    No successor points at these rows (only attached tokens were ever rotated
--    by session-aware code), and parent_id is ON DELETE SET NULL regardless.
--    CURRENT_TIMESTAMP is fixed for the transaction, so steps 1 and 2 split the
--    rows exactly.
DELETE FROM "refresh_tokens"
WHERE "session_id" IS NULL
  AND ("revoked_at" IS NOT NULL OR "expires_at" <= (CURRENT_TIMESTAMP AT TIME ZONE 'UTC'));

-- 3. Nothing session-less may remain. Should anything survive steps 1 and 2,
--    fail the whole migration (rolled back) instead of contracting.
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM "refresh_tokens" WHERE "session_id" IS NULL) THEN
        RAISE EXCEPTION 'phase15e4e1: session-less refresh tokens remain; contract aborted';
    END IF;
END
$$;

-- 4. Contract.
ALTER TABLE "refresh_tokens" ALTER COLUMN "session_id" SET NOT NULL;
