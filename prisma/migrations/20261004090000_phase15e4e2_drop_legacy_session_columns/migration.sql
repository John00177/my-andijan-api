-- Phase 15E.4e.2 — DROP step of the refresh-token contract cleanup
-- (contract: 20261003090000_phase15e4e1_refresh_token_session_contract).
--
-- Removes the dead schema that 15E.4e.1 already took out of the Prisma schema:
--   * refresh_tokens.user_agent and refresh_tokens.ip_address — never written
--     (superseded by the session-level columns on auth_sessions);
--   * SessionRevokedReason.LEGACY_MIGRATION — never written.
--
-- Migration only: the serving release (15E.4e.1) never reads or writes any of
-- these, so it is unaffected. Rollback floor afterwards: the 15E.4e.1 code —
-- anything older names the dropped columns.
--
-- Prisma applies this file as ONE transaction: a failure anywhere (a guard, the
-- lock timeout) rolls every statement back and records the migration as failed.

-- Serialize with every reader and writer of both tables for the length of this
-- transaction, taken up front in the order the application takes them
-- (auth_sessions, then refresh_tokens). If an application transaction still
-- holds either after 30 s, fail (atomically) rather than queue sign-ins.
SET LOCAL lock_timeout = '30s';
LOCK TABLE "auth_sessions", "refresh_tokens" IN ACCESS EXCLUSIVE MODE;

-- Guards: fail rather than discard data. Both conditions were verified as
-- empty in production before this release (15E.4e.2 gate, 2026-10-04).
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM "auth_sessions" WHERE "revoked_reason"::text = 'LEGACY_MIGRATION') THEN
        RAISE EXCEPTION 'phase15e4e2: auth_sessions rows with revoked_reason LEGACY_MIGRATION exist; refusing to drop the enum value';
    END IF;
    IF EXISTS (SELECT 1 FROM "refresh_tokens" WHERE "user_agent" IS NOT NULL OR "ip_address" IS NOT NULL) THEN
        RAISE EXCEPTION 'phase15e4e2: refresh_tokens.user_agent/ip_address hold data; refusing to drop the columns';
    END IF;
END $$;

-- 1. The two never-written columns.
ALTER TABLE "refresh_tokens" DROP COLUMN "user_agent", DROP COLUMN "ip_address";

-- 2. The never-written enum value. PostgreSQL cannot drop a value from an enum,
--    so the type is recreated without it (Prisma's own pattern). The cast is
--    total: the guard above proved no row holds LEGACY_MIGRATION.
ALTER TYPE "SessionRevokedReason" RENAME TO "SessionRevokedReason_old";
CREATE TYPE "SessionRevokedReason" AS ENUM ('LOGOUT', 'PASSWORD_RESET', 'SUSPENDED', 'REUSE_DETECTED');
ALTER TABLE "auth_sessions"
    ALTER COLUMN "revoked_reason" TYPE "SessionRevokedReason"
    USING ("revoked_reason"::text::"SessionRevokedReason");
DROP TYPE "SessionRevokedReason_old";
