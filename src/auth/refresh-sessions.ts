import { Prisma, SessionRevokedReason } from '@prisma/client';
import { getRequestContext } from '../common/request-context/request-context';

// Refresh-token sessions (Phase 15E.4b). An AuthSession is one sign-in on one
// device; every refresh token belongs to exactly one session and rotation
// keeps it there. See docs/my-andijan/PHASE_15E4_REFRESH_TOKEN_ARCHITECTURE.md
// (frontend repository) for the full design.
//
// CONCURRENCY — PostgreSQL is the only source of truth; nothing here relies on
// in-process state, so it holds with any number of replicas.
//
//   Lock order, everywhere: user row → session rows → token rows. Every
//   refresh and every revocation takes the session row's lock before it
//   touches that session's tokens. (refresh_tokens.session_id is NOT NULL
//   since Phase 15E.4e.1, so there is no session-less token to lock first.)
//
//   The locks are taken by CONDITIONAL UPDATEs, not by a SELECT followed by a
//   decision. Prisma 5.22 emits `updateMany` with scalar filters as one
//   statement — `UPDATE … SET … WHERE id = $1 AND revoked_at IS NULL AND …` —
//   (verified from Prisma's query log against PostgreSQL 16). Under READ
//   COMMITTED such an UPDATE blocks while another transaction holds the row,
//   then re-evaluates its WHERE clause against the newly committed version, and
//   its row count is the compare-and-set result. No raw SQL is needed.
//
//   The database backstop: refresh_tokens.parent_id is UNIQUE, so even a bug
//   in this code could not insert a second successor of one token.
//
// The real-PostgreSQL proof: test/db/refresh-sessions.db-spec.ts (npm run test:db).

/** A session ends this long after sign-in, however actively it is refreshed. */
export const ABSOLUTE_SESSION_TTL_MS = 90 * 24 * 60 * 60 * 1000;

/**
 * How recently a token may have been rotated for a second presentation of it
 * to count as a benign concurrent race (two tabs, a retried request) rather
 * than possible reuse. 15E.4b only provides the data and the classification;
 * acting on it (observe, then revoke on reuse) is Phase 15E.4c.
 */
export const REFRESH_GRACE_WINDOW_MS = 10_000;

/**
 * Clock-skew tolerance ONLY: how far in the FUTURE (relative to the checking
 * clock) a rotation timestamp may be and still count as recent. A rotation
 * stamped a few milliseconds ahead comes from another request's clock (read
 * after ours) or another replica's clock. Anything further ahead is not a
 * plausible skew and is never treated as inside the grace window.
 */
export const MAX_CLOCK_SKEW_MS = 5_000;

const MAX_USER_AGENT = 500;
const MAX_IP = 45;

/**
 * A refresh token never outlives its session: min(now + TTL, absolute expiry).
 */
export function refreshTokenExpiry(now: Date, ttlMs: number, absoluteExpiresAt: Date): Date {
  return new Date(Math.min(now.getTime() + ttlMs, absoluteExpiresAt.getTime()));
}

/** User agent and client address of the current request, bounded to the column widths. */
export function sessionDeviceMetadata(): { userAgent: string | null; ipAddress: string | null } {
  const context = getRequestContext();
  return {
    userAgent: context?.userAgent?.slice(0, MAX_USER_AGENT) ?? null,
    ipAddress: context?.ipAddress?.slice(0, MAX_IP) ?? null,
  };
}

/**
 * Was this already-rotated token presented again within the grace window,
 * before its successor was ever used? True = indistinguishable from a benign
 * client race; false = reuse. Two callers, two meanings:
 *   - refresh (15E.4c): true only spares the session from reuse revocation —
 *     the token is still refused with the generic 401 and never yields a
 *     successor (see classifyRotatedPresentation);
 *   - logout (15E.4b): true lets the token still end its own session, because
 *     that is a client signing out mid-refresh.
 */
export function isWithinRefreshGraceWindow(
  token: { rotatedAt: Date | null },
  successor: { rotatedAt: Date | null } | null,
  now: Date,
): boolean {
  if (!token.rotatedAt) return false;
  // Bounded both ways: at most REFRESH_GRACE_WINDOW_MS in the past, and at
  // most MAX_CLOCK_SKEW_MS in the future (clock skew, nothing more).
  const sinceRotation = now.getTime() - token.rotatedAt.getTime();
  return (
    sinceRotation >= -MAX_CLOCK_SKEW_MS && sinceRotation <= REFRESH_GRACE_WINDOW_MS && !successor?.rotatedAt
  );
}

/**
 * What a refresh that failed its compare-and-set was presented (Phase 15E.4c).
 * Evaluate it on state re-read under the session lock and on a clock read
 * after that re-read.
 *   - 'not-rotated': expired or revoked without ever being rotated — not reuse;
 *   - 'benign-race': rotated inside the grace window, successor unused — the
 *     same client racing its own rotation; refused, session left alone;
 *   - 'reuse': any other rotated token — older than the window, stamped beyond
 *     the clock-skew tolerance, or with its successor already used. Expiry does
 *     not change this: a rotated token is a copy whether or not it has expired.
 */
export type RotatedPresentation = 'not-rotated' | 'benign-race' | 'reuse';

export function classifyRotatedPresentation(
  token: { rotatedAt: Date | null },
  successor: { rotatedAt: Date | null } | null,
  now: Date,
): RotatedPresentation {
  if (!token.rotatedAt) return 'not-rotated';
  return isWithinRefreshGraceWindow(token, successor, now) ? 'benign-race' : 'reuse';
}

type SessionClient = Pick<Prisma.TransactionClient, 'authSession' | 'refreshToken'>;

/**
 * Ends ONE session after refresh-token reuse (Phase 15E.4c): the session
 * (REUSE_DETECTED) and then every one of its tokens, in a fresh statement
 * snapshot that includes any successor committed before we took the lock.
 * The caller must already hold that session's row lock. Other sessions of the
 * user and the user's sessionVersion are deliberately left alone.
 */
export async function revokeSessionForReuse(
  tx: SessionClient,
  sessionId: number,
  now: Date,
): Promise<{ sessionRevoked: boolean; tokensRevoked: number }> {
  const session = await tx.authSession.updateMany({
    where: { id: sessionId, revokedAt: null },
    data: { revokedAt: now, revokedReason: SessionRevokedReason.REUSE_DETECTED },
  });
  if (session.count !== 1) return { sessionRevoked: false, tokensRevoked: 0 };
  const tokens = await tx.refreshToken.updateMany({
    where: { sessionId, revokedAt: null },
    data: { revokedAt: now },
  });
  return { sessionRevoked: true, tokensRevoked: tokens.count };
}

/**
 * Ends every session of one user (password reset, suspension). Call it inside
 * the transaction that has ALREADY written the user row (status and/or
 * sessionVersion), so the user row is the first lock taken.
 *
 *   1. Every unrevoked session. Each UPDATE waits for any refresh holding that
 *      session's row, so a rotation in flight either commits first (and its
 *      successor is caught by step 2) or runs after us (and finds the session
 *      revoked).
 *   2. Every unrevoked token of the user, in a fresh statement snapshot that
 *      includes any successor committed while step 1 waited.
 *
 * Revoked sessions stay revoked: nothing — reinstatement included — revives one.
 */
export async function revokeAllUserSessions(
  tx: SessionClient,
  userId: number,
  reason: SessionRevokedReason,
  now: Date,
): Promise<{ sessionsRevoked: number; tokensRevoked: number }> {
  const sessions = await tx.authSession.updateMany({
    where: { userId, revokedAt: null },
    data: { revokedAt: now, revokedReason: reason },
  });
  const tokens = await tx.refreshToken.updateMany({
    where: { userId, revokedAt: null },
    data: { revokedAt: now },
  });
  return { sessionsRevoked: sessions.count, tokensRevoked: tokens.count };
}
