import { PrismaClient } from '@prisma/client';
import { execSync } from 'child_process';
import { cpSync, mkdtempSync, readdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createTestPrisma, testDatabaseUrl } from './support';

// Phase 15E.4b migration — expand + backfill, applied the way production gets
// it: on a database that already holds data written by the previous release.
// Uses its own throwaway database (<test db>_migration), created and dropped here.

const MIGRATION = '20261002090000_phase15e4b_auth_sessions';
const REPO = join(__dirname, '..', '..');
const DAY = 24 * 60 * 60 * 1000;

describe('Migration 20261002090000_phase15e4b_auth_sessions on existing data', () => {
  let admin: PrismaClient;
  let db: PrismaClient;
  let workDir: string;
  let dbName: string;
  let dbUrl: string;

  const deploy = (schemaPath: string) =>
    execSync(`npx prisma migrate deploy --schema "${schemaPath}"`, {
      cwd: REPO,
      env: { ...process.env, DATABASE_URL: dbUrl },
      stdio: ['ignore', 'ignore', 'inherit'],
    });

  beforeAll(async () => {
    const base = new URL(testDatabaseUrl());
    dbName = `${base.pathname.replace(/^\//, '')}_migration`;
    base.pathname = `/${dbName}`;
    base.searchParams.delete('connection_limit');
    dbUrl = base.toString();

    admin = createTestPrisma();
    await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
    await admin.$executeRawUnsafe(
      `CREATE DATABASE "${dbName}" ENCODING 'UTF8' TEMPLATE template0 LC_COLLATE 'C' LC_CTYPE 'C'`,
    );

    // The schema as the previous release deployed it: every migration but this one.
    workDir = mkdtempSync(join(tmpdir(), 'p15e4b-migration-'));
    cpSync(join(REPO, 'prisma', 'schema.prisma'), join(workDir, 'schema.prisma'));
    for (const entry of readdirSync(join(REPO, 'prisma', 'migrations'))) {
      if (entry !== MIGRATION) {
        cpSync(join(REPO, 'prisma', 'migrations', entry), join(workDir, 'migrations', entry), { recursive: true });
      }
    }
    deploy(join(workDir, 'schema.prisma'));

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
    if (workDir) rmSync(workDir, { recursive: true, force: true });
  });

  it('gives every live legacy token its own session, leaves dead ones alone, and signs nobody out', async () => {
    deploy(join(REPO, 'prisma', 'schema.prisma')); // the 15E.4b migration, on top of existing data

    const tokens = await db.refreshToken.findMany({ orderBy: { id: 'asc' }, include: { session: true } });
    const byHash = Object.fromEntries(tokens.map((t) => [t.tokenHash, t]));

    for (const hash of ['hash-active-1', 'hash-active-2', 'hash-long-live']) {
      const token = byHash[hash];
      expect(token.session).not.toBeNull();
      expect(token.session!.userId).toBe(token.userId);
      expect(token.session!.createdAt).toEqual(token.createdAt);
      expect(token.session!.revokedAt).toBeNull();
      // Never earlier than the token's own expiry: the backfill shortens nothing.
      expect(token.session!.absoluteExpiresAt.getTime()).toBeGreaterThanOrEqual(token.expiresAt.getTime());
      expect(token.revokedAt).toBeNull();
      expect(token.rotatedAt).toBeNull();
      expect(token.parentId).toBeNull();
    }
    expect(byHash['hash-active-1'].session!.absoluteExpiresAt.getTime()).toBe(
      byHash['hash-active-1'].createdAt.getTime() + 90 * DAY,
    );
    // Created 100 days ago but valid for 5 more: keeps its 5 days.
    expect(byHash['hash-long-live'].session!.absoluteExpiresAt).toEqual(byHash['hash-long-live'].expiresAt);

    expect(byHash['hash-revoked'].sessionId).toBeNull();
    expect(byHash['hash-expired'].sessionId).toBeNull();
    expect(new Set(tokens.filter((t) => t.sessionId).map((t) => t.sessionId)).size).toBe(3);
    expect(await db.authSession.count()).toBe(3);
  });

  it("the previous release's INSERT still works against the expanded schema", async () => {
    await expect(
      db.$executeRawUnsafe(
        `INSERT INTO refresh_tokens (user_id, token_hash, expires_at) VALUES (2, 'hash-written-during-switchover', now() + interval '30 days')`,
      ),
    ).resolves.toBe(1);
    const row = await db.refreshToken.findUniqueOrThrow({ where: { tokenHash: 'hash-written-during-switchover' } });
    expect(row).toEqual(expect.objectContaining({ sessionId: null, rotatedAt: null, parentId: null }));
  });
});
