import { PrismaClient } from '@prisma/client';
import { rmSync } from 'fs';
import {
  createTestPrisma,
  deployMigrations,
  migrationsWorkDir,
  recreateDatabase,
  scratchDatabaseUrl,
} from './support';

// Phase 15E.4b migration — expand + backfill, applied the way production gets
// it: on a database that already holds data written by the previous release.
// Uses its own throwaway database (<test db>_migration), created and dropped here.
//
// Pinned to the schema as it was right after this migration: later migrations
// (the 15E.4e.1 contract) are not applied here, and rows are read with raw SQL
// because the current Prisma client cannot represent a session-less token.

const MIGRATION = '20261002090000_phase15e4b_auth_sessions';
const DAY = 24 * 60 * 60 * 1000;

type Row = {
  token_hash: string;
  user_id: number;
  created_at: Date;
  expires_at: Date;
  revoked_at: Date | null;
  rotated_at: Date | null;
  parent_id: number | null;
  session_id: number | null;
  s_user_id: number | null;
  s_created_at: Date | null;
  s_revoked_at: Date | null;
  s_absolute_expires_at: Date | null;
};

describe('Migration 20261002090000_phase15e4b_auth_sessions on existing data', () => {
  let admin: PrismaClient;
  let db: PrismaClient;
  const workDirs: string[] = [];
  const { url: dbUrl, name: dbName } = scratchDatabaseUrl('migration');

  const deployThrough = (predicate: (m: string) => boolean) => {
    const dir = migrationsWorkDir(predicate);
    workDirs.push(dir);
    const result = deployMigrations(dir, dbUrl);
    if (!result.ok) throw new Error('prisma migrate deploy failed on the scratch database');
  };

  beforeAll(async () => {
    admin = createTestPrisma();
    await recreateDatabase(admin, dbName);

    // The schema as the previous release deployed it: every migration before this one.
    deployThrough((m) => m < MIGRATION);

    db = new PrismaClient({ datasources: { db: { url: dbUrl } } });
    // Rows exactly as the previous release writes them.
    await db.$executeRawUnsafe(`
      INSERT INTO users (id, phone, password_hash, full_name, updated_at) VALUES
        (1, '+998900000101', 'x', 'A', now()), (2, '+998900000102', 'x', 'B', now())`);
    await db.$executeRawUnsafe(`
      INSERT INTO refresh_tokens (id, user_id, token_hash, expires_at, revoked_at, created_at) VALUES
        (1, 1, 'hash-active-1',  now() + interval '20 days', NULL, now() - interval '10 days'),
        (2, 1, 'hash-active-2',  now() + interval '29 days', NULL, now() - interval '1 day'),
        (3, 1, 'hash-revoked',   now() + interval '20 days', now() - interval '1 day', now() - interval '10 days'),
        (4, 2, 'hash-expired',   now() - interval '1 day',   NULL, now() - interval '31 days'),
        (5, 2, 'hash-long-live', now() + interval '5 days',  NULL, now() - interval '100 days')`);
    await db.$executeRawUnsafe(`SELECT setval(pg_get_serial_sequence('refresh_tokens', 'id'), 5)`);
  });

  afterAll(async () => {
    await db?.$disconnect();
    await admin?.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
    await admin?.$disconnect();
    for (const dir of workDirs) rmSync(dir, { recursive: true, force: true });
  });

  it('gives every live legacy token its own session, leaves dead ones alone, and signs nobody out', async () => {
    deployThrough((m) => m <= MIGRATION); // the 15E.4b migration, on top of existing data

    const rows = await db.$queryRawUnsafe<Row[]>(`
      SELECT t.token_hash, t.user_id, t.created_at, t.expires_at, t.revoked_at, t.rotated_at, t.parent_id, t.session_id,
             s.user_id AS s_user_id, s.created_at AS s_created_at, s.revoked_at AS s_revoked_at,
             s.absolute_expires_at AS s_absolute_expires_at
      FROM refresh_tokens t LEFT JOIN auth_sessions s ON s.id = t.session_id
      ORDER BY t.id`);
    const byHash = Object.fromEntries(rows.map((r) => [r.token_hash, r]));

    for (const hash of ['hash-active-1', 'hash-active-2', 'hash-long-live']) {
      const token = byHash[hash];
      expect(token.session_id).not.toBeNull();
      expect(token.s_user_id).toBe(token.user_id);
      expect(token.s_created_at).toEqual(token.created_at);
      expect(token.s_revoked_at).toBeNull();
      // Never earlier than the token's own expiry: the backfill shortens nothing.
      expect(token.s_absolute_expires_at!.getTime()).toBeGreaterThanOrEqual(token.expires_at.getTime());
      expect(token.revoked_at).toBeNull();
      expect(token.rotated_at).toBeNull();
      expect(token.parent_id).toBeNull();
    }
    expect(byHash['hash-active-1'].s_absolute_expires_at!.getTime()).toBe(
      byHash['hash-active-1'].created_at.getTime() + 90 * DAY,
    );
    // Created 100 days ago but valid for 5 more: keeps its 5 days.
    expect(byHash['hash-long-live'].s_absolute_expires_at).toEqual(byHash['hash-long-live'].expires_at);

    expect(byHash['hash-revoked'].session_id).toBeNull();
    expect(byHash['hash-expired'].session_id).toBeNull();
    expect(new Set(rows.filter((t) => t.session_id).map((t) => t.session_id)).size).toBe(3);
    const [{ sessions }] = await db.$queryRawUnsafe<Array<{ sessions: number }>>(
      `SELECT count(*)::int AS sessions FROM auth_sessions`,
    );
    expect(sessions).toBe(3);
  });

  it("the previous release's INSERT still works against the expanded schema", async () => {
    await expect(
      db.$executeRawUnsafe(
        `INSERT INTO refresh_tokens (user_id, token_hash, expires_at) VALUES (2, 'hash-written-during-switchover', now() + interval '30 days')`,
      ),
    ).resolves.toBe(1);
    const [row] = await db.$queryRawUnsafe<Array<Pick<Row, 'session_id' | 'rotated_at' | 'parent_id'>>>(
      `SELECT session_id, rotated_at, parent_id FROM refresh_tokens WHERE token_hash = 'hash-written-during-switchover'`,
    );
    expect(row).toEqual({ session_id: null, rotated_at: null, parent_id: null });
  });
});
