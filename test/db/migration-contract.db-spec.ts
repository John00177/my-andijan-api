import { PrismaClient } from '@prisma/client';
import { createHash } from 'crypto';
import { rmSync } from 'fs';
import {
  createTestPrisma,
  deployMigrations,
  migrationsWorkDir,
  recreateDatabase,
  scratchDatabaseUrl,
  services,
} from './support';

// Phase 15E.4e.1 — the CONTRACT migration (refresh_tokens.session_id NOT NULL),
// applied the way production gets it: `prisma migrate deploy` on a database at
// the previous release's schema (06d6de9), already holding session-less rows.
// Each test uses its own throwaway database next to the test database.
//
// Fixture timestamps are written in UTC, as Prisma writes them, so the
// migration's UTC comparisons are exercised even when the server's TimeZone
// is not UTC.

const MIGRATION = '20261003090000_phase15e4e1_refresh_token_session_contract';
const DAY = 24 * 60 * 60 * 1000;
const UTC_NOW = `(now() AT TIME ZONE 'UTC')`;
const sha256 = (raw: string) => createHash('sha256').update(raw).digest('hex');

const RAW = {
  live: 'a'.repeat(96), // session-less, live → attached
  liveLong: 'b'.repeat(96), // session-less, created 100 days ago, 5 days left → attached, keeps its expiry
  liveEdge: 'c'.repeat(96), // session-less, expires in 2 minutes (UTC) → attached
  revoked: 'd'.repeat(96), // session-less, revoked → deleted
  expired: 'e'.repeat(96), // session-less, expired 10 days ago → deleted
  expiredEdge: 'f'.repeat(96), // session-less, expired 2 minutes ago (UTC) → deleted
  oldRotated: '1'.repeat(96), // rotated by the pre-15E.4b release: revoked, rotated_at NULL → deleted
  chainRoot: '2'.repeat(96), // in a live session, rotated
  chainCurrent: '3'.repeat(96), // its successor, live
  inRevokedSession: '4'.repeat(96),
};

type TokenRow = {
  id: number;
  user_id: number;
  session_id: number | null;
  parent_id: number | null;
  rotated_at: Date | null;
  revoked_at: Date | null;
  created_at: Date;
  expires_at: Date;
};
type SessionRow = {
  id: number;
  user_id: number;
  created_at: Date;
  absolute_expires_at: Date;
  last_used_at: Date;
  revoked_at: Date | null;
  revoked_reason: string | null;
};

/** The previous release's schema, with session-less rows of every kind plus normal session data. */
async function seedPreviousReleaseData(db: PrismaClient): Promise<void> {
  await db.$executeRawUnsafe(`
    INSERT INTO users (id, phone, password_hash, full_name, updated_at) VALUES
      (1, '+998900000201', 'x', 'A', now()), (2, '+998900000202', 'x', 'B', now()), (3, '+998900000203', 'x', 'C', now())`);
  await db.$executeRawUnsafe(`
    INSERT INTO auth_sessions (id, user_id, created_at, absolute_expires_at, last_used_at, revoked_at, revoked_reason) VALUES
      (100, 3, ${UTC_NOW} - interval '1 day', ${UTC_NOW} + interval '89 days', ${UTC_NOW} - interval '1 hour', NULL, NULL),
      (101, 3, ${UTC_NOW} - interval '2 days', ${UTC_NOW} + interval '88 days', ${UTC_NOW} - interval '2 days', ${UTC_NOW} - interval '1 day', 'LOGOUT')`);
  await db.$executeRawUnsafe(`
    INSERT INTO refresh_tokens (id, user_id, token_hash, created_at, expires_at, revoked_at, rotated_at, session_id, parent_id) VALUES
      (1, 1, '${sha256(RAW.live)}',        ${UTC_NOW} - interval '10 days',  ${UTC_NOW} + interval '20 days',  NULL, NULL, NULL, NULL),
      (2, 2, '${sha256(RAW.liveLong)}',    ${UTC_NOW} - interval '100 days', ${UTC_NOW} + interval '5 days',   NULL, NULL, NULL, NULL),
      (3, 1, '${sha256(RAW.liveEdge)}',    ${UTC_NOW} - interval '30 days',  ${UTC_NOW} + interval '2 minutes', NULL, NULL, NULL, NULL),
      (4, 1, '${sha256(RAW.revoked)}',     ${UTC_NOW} - interval '5 days',   ${UTC_NOW} + interval '25 days',  ${UTC_NOW} - interval '1 day', NULL, NULL, NULL),
      (5, 2, '${sha256(RAW.expired)}',     ${UTC_NOW} - interval '40 days',  ${UTC_NOW} - interval '10 days',  NULL, NULL, NULL, NULL),
      (6, 2, '${sha256(RAW.expiredEdge)}', ${UTC_NOW} - interval '30 days',  ${UTC_NOW} - interval '2 minutes', NULL, NULL, NULL, NULL),
      (7, 1, '${sha256(RAW.oldRotated)}',  ${UTC_NOW} - interval '60 days',  ${UTC_NOW} - interval '30 days',  ${UTC_NOW} - interval '59 days', NULL, NULL, NULL),
      (8, 3, '${sha256(RAW.chainRoot)}',   ${UTC_NOW} - interval '1 day',    ${UTC_NOW} + interval '29 days',  ${UTC_NOW} - interval '1 hour', ${UTC_NOW} - interval '1 hour', 100, NULL),
      (9, 3, '${sha256(RAW.chainCurrent)}', ${UTC_NOW} - interval '1 hour',  ${UTC_NOW} + interval '30 days',  NULL, NULL, 100, 8),
      (10, 3, '${sha256(RAW.inRevokedSession)}', ${UTC_NOW} - interval '2 days', ${UTC_NOW} + interval '28 days', ${UTC_NOW} - interval '1 day', NULL, 101, NULL)`);
  await db.$executeRawUnsafe(`SELECT setval(pg_get_serial_sequence('auth_sessions', 'id'), 101)`);
  await db.$executeRawUnsafe(`SELECT setval(pg_get_serial_sequence('refresh_tokens', 'id'), 10)`);
}

const tokens = (db: PrismaClient) =>
  db.$queryRawUnsafe<TokenRow[]>(
    `SELECT id, user_id, session_id, parent_id, rotated_at, revoked_at, created_at, expires_at FROM refresh_tokens ORDER BY id`,
  );
const sessions = (db: PrismaClient) =>
  db.$queryRawUnsafe<SessionRow[]>(
    `SELECT id, user_id, created_at, absolute_expires_at, last_used_at, revoked_at, revoked_reason::text AS revoked_reason
     FROM auth_sessions ORDER BY id`,
  );
const sessionIdNullable = async (db: PrismaClient) =>
  (
    await db.$queryRawUnsafe<Array<{ is_nullable: string }>>(
      `SELECT is_nullable FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'refresh_tokens' AND column_name = 'session_id'`,
    )
  )[0].is_nullable;
const migrationRow = async (db: PrismaClient) =>
  (
    await db.$queryRawUnsafe<Array<{ finished: boolean; rolled_back: boolean }>>(
      `SELECT finished_at IS NOT NULL AS finished, rolled_back_at IS NOT NULL AS rolled_back
       FROM _prisma_migrations WHERE migration_name = '${MIGRATION}'`,
    )
  )[0];

describe('Migration 20261003090000_phase15e4e1_refresh_token_session_contract (Phase 15E.4e.1)', () => {
  let admin: PrismaClient;
  const workDirs: string[] = [];
  const opened: PrismaClient[] = [];
  const scratch: string[] = [];

  /** A scratch database at the previous release's schema (every migration before the contract), seeded. */
  async function previousReleaseDatabase(suffix: string): Promise<{ db: PrismaClient; url: string }> {
    const { url, name } = scratchDatabaseUrl(suffix);
    scratch.push(name);
    await recreateDatabase(admin, name);
    const dir = migrationsWorkDir((m) => m < MIGRATION);
    workDirs.push(dir);
    if (!deployMigrations(dir, url).ok) throw new Error('could not build the previous-release schema');
    const db = new PrismaClient({ datasources: { db: { url } } });
    opened.push(db);
    await seedPreviousReleaseData(db);
    return { db, url };
  }

  function deployContract(url: string, append?: string) {
    const dir = migrationsWorkDir((m) => m <= MIGRATION, append ? { migration: MIGRATION, sql: append } : undefined);
    workDirs.push(dir);
    return deployMigrations(dir, url);
  }

  beforeAll(() => {
    admin = createTestPrisma();
  });

  afterAll(async () => {
    for (const db of opened) await db.$disconnect();
    for (const name of scratch) await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    await admin.$disconnect();
    for (const dir of workDirs) rmSync(dir, { recursive: true, force: true });
  });

  it('attaches live session-less tokens (15E.4b rule), deletes dead ones, leaves session data untouched, then enforces NOT NULL', async () => {
    const { db, url } = await previousReleaseDatabase('contract');
    expect(await sessionIdNullable(db)).toBe('YES');
    const before = await tokens(db);
    const sessionsBefore = await sessions(db);

    const result = deployContract(url);

    expect(result.ok).toBe(true);
    expect(await migrationRow(db)).toEqual({ finished: true, rolled_back: false });
    expect(await sessionIdNullable(db)).toBe('NO');

    const after = await tokens(db);
    const byId = new Map(after.map((t) => [t.id, t]));
    // Dead session-less rows are gone; nothing else is.
    expect([...byId.keys()]).toEqual([1, 2, 3, 8, 9, 10]);
    expect(after.every((t) => t.session_id !== null)).toBe(true);

    // Live session-less tokens: attached, each to a NEW session of its own user,
    // by exactly the 15E.4b backfill rule; the token itself is otherwise unchanged.
    const allSessions = await sessions(db);
    const sessionOf = (id: number) => allSessions.find((s) => s.id === byId.get(id)!.session_id)!;
    for (const id of [1, 2, 3]) {
      const token = byId.get(id)!;
      const original = before.find((t) => t.id === id)!;
      expect(token).toEqual({ ...original, session_id: expect.any(Number) });
      const session = sessionOf(id);
      expect(session.id).toBeGreaterThan(101);
      expect(session.user_id).toBe(token.user_id);
      expect(session.created_at).toEqual(token.created_at);
      expect(session.last_used_at).toEqual(token.created_at);
      expect(session.revoked_at).toBeNull();
      expect(session.revoked_reason).toBeNull();
      expect(session.absolute_expires_at.getTime()).toBe(
        Math.max(token.created_at.getTime() + 90 * DAY, token.expires_at.getTime()),
      );
    }
    expect(new Set([1, 2, 3].map((id) => byId.get(id)!.session_id)).size).toBe(3); // one session each
    expect(sessionOf(2).absolute_expires_at).toEqual(byId.get(2)!.expires_at); // 100 days old, keeps its 5 days

    // Existing sessions and their tokens are exactly as before.
    expect(allSessions.filter((s) => s.id <= 101)).toEqual(sessionsBefore);
    for (const id of [8, 9, 10]) expect(byId.get(id)).toEqual(before.find((t) => t.id === id));
    expect(allSessions).toHaveLength(sessionsBefore.length + 3);

    // The contract now holds in the database itself.
    const insert = await db
      .$executeRawUnsafe(
        `INSERT INTO refresh_tokens (user_id, token_hash, expires_at) VALUES (1, 'no-session', ${UTC_NOW} + interval '1 day')`,
      )
      .catch((e) => e);
    expect(String(insert?.message ?? insert)).toMatch(/23502|null value in column "session_id"/);

    // The attached token is a normal session token for the application: it
    // refreshes (successor in the same session, chained to it) and the access
    // token names that session. A deleted dead token is simply unknown.
    const { auth } = services(db);
    const next = await auth.refresh({ refreshToken: RAW.live });
    const successor = (await tokens(db)).find((t) => t.parent_id === 1)!;
    expect(successor.session_id).toBe(byId.get(1)!.session_id);
    const claims = JSON.parse(Buffer.from(next.accessToken.split('.')[1], 'base64url').toString());
    expect(claims.sid).toBe(byId.get(1)!.session_id);
    expect(claims.sub).toBe(1);
    await expect(auth.refresh({ refreshToken: RAW.revoked })).rejects.toThrow('Invalid or expired refresh token');
    await expect(auth.refresh({ refreshToken: RAW.chainCurrent })).resolves.toBeDefined();
  });

  it('is atomic: a failure after its last statement rolls ALL of it back (attach, delete and NOT NULL)', async () => {
    const { db, url } = await previousReleaseDatabase('contract_atomic');
    const before = await tokens(db);
    const sessionsBefore = await sessions(db);

    // The real migration file, plus one statement that fails after everything in it has run.
    const result = deployContract(url, `DO $$ BEGIN RAISE EXCEPTION 'injected failure after the contract'; END $$;`);

    expect(result.ok).toBe(false);
    expect(result.output).toMatch(/injected failure after the contract/);
    expect(await tokens(db)).toEqual(before); // nothing attached, nothing deleted
    expect(await sessions(db)).toEqual(sessionsBefore); // no session created
    expect(await sessionIdNullable(db)).toBe('YES'); // not contracted
    expect(await migrationRow(db)).toEqual({ finished: false, rolled_back: false }); // recorded as failed
  });

  it('gives up (atomically) instead of queueing every sign-in behind it when the table stays locked: lock_timeout 30 s', async () => {
    const { db, url } = await previousReleaseDatabase('contract_lock');
    const before = await tokens(db);
    let result!: { ok: boolean; output: string };

    // Another transaction keeps refresh_tokens locked for the whole deploy.
    await db.$transaction(
      async (tx) => {
        await tx.$executeRawUnsafe('LOCK TABLE refresh_tokens IN ACCESS SHARE MODE');
        result = deployContract(url); // synchronous: the lock is held until it returns
      },
      { timeout: 120_000, maxWait: 10_000 },
    );

    expect(result.ok).toBe(false);
    expect(result.output).toMatch(/lock timeout/);
    expect(await tokens(db)).toEqual(before);
    expect(await sessionIdNullable(db)).toBe('YES');
  }, 150_000);
});
