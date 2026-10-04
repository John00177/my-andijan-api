import { PrismaClient } from "@prisma/client";
import { execFileSync } from "child_process";
import { createHash } from "crypto";
import { rmSync } from "fs";
import { join } from "path";
import {
  createTestPrisma,
  deployMigrations,
  migrationsWorkDir,
  recreateDatabase,
  REPO_ROOT,
  scratchDatabaseUrl,
  services,
} from "./support";

// Phase 15E.4e.2 — the DROP migration (refresh_tokens.user_agent/ip_address and
// SessionRevokedReason.LEGACY_MIGRATION), applied the way production gets it:
// `prisma migrate deploy` on a database at the 15E.4e.1 schema, holding normal
// session data, while a client of the serving release (15E.4e.1 — this code)
// is already connected. Each test uses its own throwaway database.

const MIGRATION = "20261004090000_phase15e4e2_drop_legacy_session_columns";
const UTC_NOW = `(now() AT TIME ZONE 'UTC')`;
const sha256 = (raw: string) => createHash("sha256").update(raw).digest("hex");

const RAW = {
  live: "a".repeat(96), // session 100 (live), current token
  liveRoot: "b".repeat(96), // session 100, rotated predecessor of `live`
  otherUser: "c".repeat(96), // session 102 (live), another user
};

type TokenRow = {
  id: number;
  user_id: number;
  session_id: number;
  parent_id: number | null;
  rotated_at: Date | null;
  revoked_at: Date | null;
  expires_at: Date;
};
type SessionRow = {
  id: number;
  user_id: number;
  revoked_at: Date | null;
  revoked_reason: string | null;
};

/** Normal 15E.4e.1 data: a live session with a rotated chain, ended sessions of every reason, another user. */
async function seedCurrentReleaseData(db: PrismaClient): Promise<void> {
  await db.$executeRawUnsafe(`
    INSERT INTO users (id, phone, password_hash, full_name, updated_at) VALUES
      (1, '+998900000301', 'x', 'A', now()), (2, '+998900000302', 'x', 'B', now())`);
  await db.$executeRawUnsafe(`
    INSERT INTO auth_sessions (id, user_id, created_at, absolute_expires_at, last_used_at, revoked_at, revoked_reason) VALUES
      (100, 1, ${UTC_NOW} - interval '1 day', ${UTC_NOW} + interval '89 days', ${UTC_NOW} - interval '1 hour', NULL, NULL),
      (101, 1, ${UTC_NOW} - interval '9 days', ${UTC_NOW} + interval '81 days', ${UTC_NOW} - interval '8 days', ${UTC_NOW} - interval '8 days', 'LOGOUT'),
      (102, 2, ${UTC_NOW} - interval '2 days', ${UTC_NOW} + interval '88 days', ${UTC_NOW} - interval '2 days', NULL, NULL),
      (103, 2, ${UTC_NOW} - interval '7 days', ${UTC_NOW} + interval '83 days', ${UTC_NOW} - interval '6 days', ${UTC_NOW} - interval '6 days', 'PASSWORD_RESET'),
      (104, 2, ${UTC_NOW} - interval '6 days', ${UTC_NOW} + interval '84 days', ${UTC_NOW} - interval '5 days', ${UTC_NOW} - interval '5 days', 'SUSPENDED'),
      (105, 1, ${UTC_NOW} - interval '5 days', ${UTC_NOW} + interval '85 days', ${UTC_NOW} - interval '4 days', ${UTC_NOW} - interval '4 days', 'REUSE_DETECTED')`);
  await db.$executeRawUnsafe(`
    INSERT INTO refresh_tokens (id, user_id, token_hash, created_at, expires_at, revoked_at, rotated_at, session_id, parent_id) VALUES
      (1, 1, '${sha256(RAW.liveRoot)}', ${UTC_NOW} - interval '1 day',  ${UTC_NOW} + interval '29 days', ${UTC_NOW} - interval '1 hour', ${UTC_NOW} - interval '1 hour', 100, NULL),
      (2, 1, '${sha256(RAW.live)}',     ${UTC_NOW} - interval '1 hour', ${UTC_NOW} + interval '30 days', NULL, NULL, 100, 1),
      (3, 1, '${sha256("d".repeat(96))}', ${UTC_NOW} - interval '9 days', ${UTC_NOW} + interval '21 days', ${UTC_NOW} - interval '8 days', NULL, 101, NULL),
      (4, 2, '${sha256(RAW.otherUser)}', ${UTC_NOW} - interval '2 days', ${UTC_NOW} + interval '28 days', NULL, NULL, 102, NULL),
      (5, 2, '${sha256("e".repeat(96))}', ${UTC_NOW} - interval '7 days', ${UTC_NOW} + interval '23 days', ${UTC_NOW} - interval '6 days', NULL, 103, NULL),
      (6, 2, '${sha256("f".repeat(96))}', ${UTC_NOW} - interval '6 days', ${UTC_NOW} + interval '24 days', ${UTC_NOW} - interval '5 days', NULL, 104, NULL),
      (7, 1, '${sha256("1".repeat(96))}', ${UTC_NOW} - interval '5 days', ${UTC_NOW} + interval '25 days', ${UTC_NOW} - interval '4 days', NULL, 105, NULL)`);
  await db.$executeRawUnsafe(
    `SELECT setval(pg_get_serial_sequence('auth_sessions', 'id'), 105)`,
  );
  await db.$executeRawUnsafe(
    `SELECT setval(pg_get_serial_sequence('refresh_tokens', 'id'), 7)`,
  );
}

const tokens = (db: PrismaClient) =>
  db.$queryRawUnsafe<TokenRow[]>(
    `SELECT id, user_id, session_id, parent_id, rotated_at, revoked_at, expires_at FROM refresh_tokens ORDER BY id`,
  );
const sessions = (db: PrismaClient) =>
  db.$queryRawUnsafe<SessionRow[]>(
    `SELECT id, user_id, revoked_at, revoked_reason::text AS revoked_reason FROM auth_sessions ORDER BY id`,
  );
const legacyColumns = async (db: PrismaClient) =>
  (
    await db.$queryRawUnsafe<Array<{ column_name: string }>>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'refresh_tokens' AND column_name IN ('user_agent', 'ip_address')
       ORDER BY column_name`,
    )
  ).map((r) => r.column_name);
const enumLabels = async (db: PrismaClient) =>
  (
    await db.$queryRawUnsafe<Array<{ enumlabel: string }>>(
      `SELECT e.enumlabel FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
       WHERE t.typname = 'SessionRevokedReason' ORDER BY e.enumsortorder`,
    )
  ).map((r) => r.enumlabel);
const leftoverOldType = async (db: PrismaClient) =>
  (
    await db.$queryRawUnsafe<Array<{ n: number }>>(
      `SELECT count(*)::int AS n FROM pg_type WHERE typname = 'SessionRevokedReason_old'`,
    )
  )[0].n;
const migrationRow = async (db: PrismaClient) =>
  (
    await db.$queryRawUnsafe<
      Array<{ finished: boolean; rolled_back: boolean }>
    >(
      `SELECT finished_at IS NOT NULL AS finished, rolled_back_at IS NOT NULL AS rolled_back
       FROM _prisma_migrations WHERE migration_name = '${MIGRATION}'`,
    )
  )[0];

/** Exit code of `prisma migrate diff` from the live database to prisma/schema.prisma (0 = identical). */
function schemaDriftExitCode(url: string): number {
  try {
    execFileSync(
      "npx",
      [
        "prisma",
        "migrate",
        "diff",
        "--from-url",
        url,
        "--to-schema-datamodel",
        join(REPO_ROOT, "prisma", "schema.prisma"),
        "--exit-code",
      ],
      {
        cwd: REPO_ROOT,
        stdio: ["ignore", "pipe", "pipe"],
        shell: process.platform === "win32",
        timeout: 120_000,
      },
    );
    return 0;
  } catch (error) {
    return (error as { status?: number }).status ?? -1;
  }
}

describe("Migration 20261004090000_phase15e4e2_drop_legacy_session_columns (Phase 15E.4e.2)", () => {
  let admin: PrismaClient;
  const workDirs: string[] = [];
  const opened: PrismaClient[] = [];
  const scratch: string[] = [];

  /** A scratch database at the 15E.4e.1 schema (every migration before the drop), seeded. */
  async function currentReleaseDatabase(
    suffix: string,
  ): Promise<{ db: PrismaClient; url: string }> {
    const { url, name } = scratchDatabaseUrl(suffix);
    scratch.push(name);
    await recreateDatabase(admin, name);
    const dir = migrationsWorkDir((m) => m < MIGRATION);
    workDirs.push(dir);
    if (!deployMigrations(dir, url).ok)
      throw new Error("could not build the 15E.4e.1 schema");
    const db = new PrismaClient({ datasources: { db: { url } } });
    opened.push(db);
    await seedCurrentReleaseData(db);
    return { db, url };
  }

  function deployDrop(url: string, append?: string) {
    const dir = migrationsWorkDir(
      (m) => m <= MIGRATION,
      append ? { migration: MIGRATION, sql: append } : undefined,
    );
    workDirs.push(dir);
    return deployMigrations(dir, url);
  }

  beforeAll(() => {
    admin = createTestPrisma();
  });

  afterAll(async () => {
    for (const db of opened) await db.$disconnect();
    for (const name of scratch)
      await admin.$executeRawUnsafe(
        `DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`,
      );
    await admin.$disconnect();
    for (const dir of workDirs) rmSync(dir, { recursive: true, force: true });
  });

  it("drops the two columns and LEGACY_MIGRATION, keeps every row and reason, and the serving release keeps working across it", async () => {
    const { db, url } = await currentReleaseDatabase("drop");
    expect(await legacyColumns(db)).toEqual(["ip_address", "user_agent"]);
    expect(await enumLabels(db)).toEqual([
      "LOGOUT",
      "PASSWORD_RESET",
      "SUSPENDED",
      "REUSE_DETECTED",
      "LEGACY_MIGRATION",
    ]);
    const tokensBefore = await tokens(db);
    const sessionsBefore = await sessions(db);

    // The serving release is connected and has already used every auth query
    // shape (sign-in session lookup, rotation, logout) before the deploy.
    const { auth } = services(db);
    const warm = await auth.refresh({ refreshToken: RAW.otherUser });
    await auth.logout(warm.refreshToken);

    const result = deployDrop(url);

    expect(result.ok).toBe(true);
    expect(await migrationRow(db)).toEqual({
      finished: true,
      rolled_back: false,
    });
    expect(await legacyColumns(db)).toEqual([]);
    expect(await enumLabels(db)).toEqual([
      "LOGOUT",
      "PASSWORD_RESET",
      "SUSPENDED",
      "REUSE_DETECTED",
    ]);
    expect(await leftoverOldType(db)).toBe(0);

    // No row lost or altered; every recorded reason survives the type swap.
    const tokensAfter = await tokens(db);
    expect(tokensAfter.filter((t) => t.id <= 7)).toEqual(
      tokensBefore.map((t) =>
        t.id === 4 ? tokensAfter.find((a) => a.id === 4)! : t,
      ),
    );
    const sessionsAfter = await sessions(db);
    expect(sessionsAfter.filter((s) => s.id !== 102)).toEqual(
      sessionsBefore.filter((s) => s.id !== 102),
    );
    expect(sessionsAfter.find((s) => s.id === 102)!.revoked_reason).toBe(
      "LOGOUT",
    ); // the warm-up logout

    // The database now matches prisma/schema.prisma exactly: no drift left.
    expect(schemaDriftExitCode(url)).toBe(0);

    // The SAME already-connected client (the 15E.4e.1 release mid rolling
    // deploy) still refreshes, rotates in-session, and logs out.
    const next = await auth.refresh({ refreshToken: RAW.live });
    const successor = (await tokens(db)).find((t) => t.parent_id === 2)!;
    expect(successor.session_id).toBe(100);
    const claims = JSON.parse(
      Buffer.from(next.accessToken.split(".")[1], "base64url").toString(),
    );
    expect(claims.sid).toBe(100);
    await auth.logout(next.refreshToken);
    expect((await sessions(db)).find((s) => s.id === 100)!.revoked_reason).toBe(
      "LOGOUT",
    );
    await expect(
      auth.refresh({ refreshToken: next.refreshToken }),
    ).rejects.toThrow("Invalid or expired refresh token");

    // The removed value can no longer be written.
    const write = await db
      .$executeRawUnsafe(
        `UPDATE auth_sessions SET revoked_reason = 'LEGACY_MIGRATION' WHERE id = 101`,
      )
      .catch((e) => e);
    expect(String(write?.message ?? write)).toMatch(
      /22P02|invalid input value for enum/,
    );
  });

  it("refuses (atomically) when a LEGACY_MIGRATION session exists", async () => {
    const { db, url } = await currentReleaseDatabase("drop_guard_enum");
    await db.$executeRawUnsafe(
      `UPDATE auth_sessions SET revoked_reason = 'LEGACY_MIGRATION' WHERE id = 101`,
    );
    const tokensBefore = await tokens(db);
    const sessionsBefore = await sessions(db);

    const result = deployDrop(url);

    expect(result.ok).toBe(false);
    expect(result.output).toMatch(
      /phase15e4e2: auth_sessions rows with revoked_reason LEGACY_MIGRATION exist/,
    );
    expect(await legacyColumns(db)).toEqual(["ip_address", "user_agent"]); // columns not dropped either
    expect(await enumLabels(db)).toHaveLength(5);
    expect(await tokens(db)).toEqual(tokensBefore);
    expect(await sessions(db)).toEqual(sessionsBefore);
    expect(await migrationRow(db)).toEqual({
      finished: false,
      rolled_back: false,
    }); // recorded as failed
  });

  it("refuses (atomically) when user_agent or ip_address holds data", async () => {
    const { db, url } = await currentReleaseDatabase("drop_guard_cols");
    await db.$executeRawUnsafe(
      `UPDATE refresh_tokens SET ip_address = '203.0.113.7' WHERE id = 3`,
    );

    const result = deployDrop(url);

    expect(result.ok).toBe(false);
    expect(result.output).toMatch(
      /phase15e4e2: refresh_tokens\.user_agent\/ip_address hold data/,
    );
    expect(await legacyColumns(db)).toEqual(["ip_address", "user_agent"]);
    expect(await enumLabels(db)).toHaveLength(5);
    expect(await migrationRow(db)).toEqual({
      finished: false,
      rolled_back: false,
    });
  });

  it("is atomic: a failure after its last statement rolls ALL of it back (columns, enum value, old type)", async () => {
    const { db, url } = await currentReleaseDatabase("drop_atomic");
    const tokensBefore = await tokens(db);
    const sessionsBefore = await sessions(db);

    const result = deployDrop(
      url,
      `DO $$ BEGIN RAISE EXCEPTION 'injected failure after the drop'; END $$;`,
    );

    expect(result.ok).toBe(false);
    expect(result.output).toMatch(/injected failure after the drop/);
    expect(await legacyColumns(db)).toEqual(["ip_address", "user_agent"]);
    expect(await enumLabels(db)).toEqual([
      "LOGOUT",
      "PASSWORD_RESET",
      "SUSPENDED",
      "REUSE_DETECTED",
      "LEGACY_MIGRATION",
    ]);
    expect(await leftoverOldType(db)).toBe(0);
    expect(await tokens(db)).toEqual(tokensBefore);
    expect(await sessions(db)).toEqual(sessionsBefore);
    expect(await migrationRow(db)).toEqual({
      finished: false,
      rolled_back: false,
    });
  });
});
