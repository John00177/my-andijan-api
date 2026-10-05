import { JwtService } from '@nestjs/jwt';
import { Prisma, PrismaClient, UserRole } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import { execFileSync } from 'child_process';
import { cpSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { AuthService } from '../../src/auth/auth.service';
import { AdminService } from '../../src/admin/admin.service';
import { PrismaService } from '../../src/prisma/prisma.service';
import { ReviewsService } from '../../src/reviews/reviews.service';
import { SmsService } from '../../src/sms/sms.service';
import { UploadService } from '../../src/upload/upload.service';

// Shared by the real-PostgreSQL suites (npm run test:db, Phase 15E.4b).
//
// SAFETY: these suites TRUNCATE tables. They run only against the database in
// TEST_DATABASE_URL, and only when it is on this machine (localhost — in CI,
// the job's own throwaway service container) and its name contains "test".
// They never fall back to DATABASE_URL or a .env file.

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

export function testDatabaseUrl(): string {
  const raw = process.env.TEST_DATABASE_URL;
  if (!raw) {
    throw new Error('TEST_DATABASE_URL is not set. The database suites need a disposable local PostgreSQL database.');
  }
  const url = new URL(raw);
  const database = url.pathname.replace(/^\//, '');
  if (!LOCAL_HOSTS.has(url.hostname) || !/test/i.test(database)) {
    // Never echo the URL: it may carry a password.
    throw new Error(
      `Refusing to run: TEST_DATABASE_URL must point at a local database whose name contains "test" ` +
        `(got host "${url.hostname}", database "${database}").`,
    );
  }
  // Room for one lock holder, ten contenders and an observer at once.
  if (!url.searchParams.has('connection_limit')) url.searchParams.set('connection_limit', '25');
  return url.toString();
}

// ---------------------------------------------------------------------------
// Migration suites: each runs on its OWN throwaway database next to the test
// database (same local server, name "<test db>_<suffix>"), built from a chosen
// prefix of prisma/migrations — so a migration is applied the way production
// gets it: on top of data the previous release wrote.
// ---------------------------------------------------------------------------

export const REPO_ROOT = join(__dirname, '..', '..');
const MIGRATIONS_DIR = join(REPO_ROOT, 'prisma', 'migrations');

/** URL of the scratch database "<test db>_<suffix>" (the same safety checks apply). */
export function scratchDatabaseUrl(suffix: string): { url: string; name: string } {
  const base = new URL(testDatabaseUrl());
  const name = `${base.pathname.replace(/^\//, '')}_${suffix}`;
  base.pathname = `/${name}`;
  base.searchParams.delete('connection_limit');
  return { url: base.toString(), name };
}

/** Drops (if present) and creates a scratch database, via a connection to the test database. */
export async function recreateDatabase(admin: PrismaClient, name: string): Promise<void> {
  await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
  await admin.$executeRawUnsafe(
    `CREATE DATABASE "${name}" ENCODING 'UTF8' TEMPLATE template0 LC_COLLATE 'C' LC_CTYPE 'C'`,
  );
}

/** Every committed migration directory name, in apply order. */
export function listMigrations(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((entry) => /^\d{14}_/.test(entry))
    .sort();
}

/**
 * A temporary Prisma project holding only the migrations `include` selects
 * (plus migration_lock.toml), optionally with extra SQL appended to one of
 * them — used to prove a migration file is applied atomically.
 */
export function migrationsWorkDir(
  include: (migration: string) => boolean,
  append?: { migration: string; sql: string },
): string {
  const dir = mkdtempSync(join(tmpdir(), 'andijan-migrations-'));
  cpSync(join(REPO_ROOT, 'prisma', 'schema.prisma'), join(dir, 'schema.prisma'));
  cpSync(join(MIGRATIONS_DIR, 'migration_lock.toml'), join(dir, 'migrations', 'migration_lock.toml'));
  for (const migration of listMigrations().filter(include)) {
    cpSync(join(MIGRATIONS_DIR, migration), join(dir, 'migrations', migration), { recursive: true });
    if (append?.migration === migration) {
      const file = join(dir, 'migrations', migration, 'migration.sql');
      writeFileSync(file, `${readFileSync(file, 'utf8')}\n${append.sql}\n`);
    }
  }
  return dir;
}

/**
 * `prisma migrate deploy` of a work dir against a scratch database. DATABASE_URL
 * is set explicitly for the child, so no .env file can redirect it. Returns the
 * outcome instead of throwing; output is kept for assertions, never printed.
 */
export function deployMigrations(workDir: string, databaseUrl: string): { ok: boolean; output: string } {
  try {
    const output = execFileSync('npx', ['prisma', 'migrate', 'deploy', '--schema', join(workDir, 'schema.prisma')], {
      cwd: REPO_ROOT,
      env: { ...process.env, DATABASE_URL: databaseUrl },
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: process.platform === 'win32', // npx is a .cmd shim on Windows
      timeout: 120_000,
    });
    return { ok: true, output: String(output) };
  } catch (error) {
    const e = error as { stdout?: Buffer; stderr?: Buffer };
    return { ok: false, output: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  }
}

// ---------------------------------------------------------------------------
// SIG Gate 2 runtime mode (npm run test:db:runtime): the application suites run
// again with the application's client connected as TEST_DB_RUNTIME_ROLE
// (runtime_app_public, after db/privileges/10_phase_a_boundary.sql) — proving
// the PUBLIC runtime works with DML only. Fixture housekeeping the runtime is
// deliberately not allowed to do (TRUNCATE) goes through a superuser client.
// ---------------------------------------------------------------------------

const RUNTIME_ROLE = process.env.TEST_DB_RUNTIME_ROLE;

/** The URL the application connects with: the test database, as the runtime role in runtime mode. */
function applicationDatabaseUrl(): string {
  const url = new URL(testDatabaseUrl());
  if (RUNTIME_ROLE) {
    // The role has no password: runtime mode needs the local trust
    // authentication CI's throwaway container uses (it fails, never passes, without it).
    url.username = RUNTIME_ROLE;
    url.password = '';
  }
  return url.toString();
}

let fixtureAdmin: PrismaClient | undefined;

/** Closes the runtime-mode fixture client (test/db/runtime-after-env.ts). */
export async function disconnectFixtureAdmin(): Promise<void> {
  await fixtureAdmin?.$disconnect();
  fixtureAdmin = undefined;
}

export function createTestPrisma(log = false): PrismaClient {
  return new PrismaClient({
    datasources: { db: { url: applicationDatabaseUrl() } },
    ...(log ? { log: [{ emit: 'event' as const, level: 'query' as const }] } : {}),
  });
}

export async function resetDatabase(prisma: PrismaClient): Promise<void> {
  const db = RUNTIME_ROLE
    ? (fixtureAdmin ??= new PrismaClient({ datasources: { db: { url: testDatabaseUrl() } } }))
    : prisma;
  await db.$executeRawUnsafe(
    'TRUNCATE TABLE "refresh_tokens", "auth_sessions", "audit_logs", "otp_codes", "users" RESTART IDENTITY CASCADE',
  );
}

export const PASSWORD = 'correct-horse-battery';

export async function createUser(prisma: PrismaClient, phone: string, role: UserRole = UserRole.CUSTOMER) {
  return prisma.user.create({
    data: { phone, fullName: 'Test', role, passwordHash: await bcrypt.hash(PASSWORD, 4) },
  });
}

export function services(prisma: PrismaClient) {
  process.env.JWT_ACCESS_SECRET = 'db-suite-access-secret';
  const db = prisma as unknown as PrismaService;
  return {
    auth: new AuthService(db, new JwtService({}), {} as SmsService, {} as UploadService),
    admin: new AdminService(db, {} as ReviewsService),
  };
}

/**
 * Starts `run` while another transaction holds the session row's lock, and
 * releases that lock only after `contenders` backends are observed (in
 * pg_stat_activity) BLOCKED on an auth_sessions row lock. So every contender
 * is provably inside its transaction and waiting at the serialization point at
 * the same moment — the race is forced, not left to timing.
 */
export async function raceAtSessionLock<T>(
  prisma: PrismaClient,
  sessionId: number,
  contenders: number,
  run: () => Promise<T>,
): Promise<T> {
  let started!: Promise<T>;
  await prisma.$transaction(
    async (tx) => {
      await tx.$queryRaw`SELECT id FROM auth_sessions WHERE id = ${sessionId} FOR UPDATE`;
      started = run();
      started.catch(() => undefined); // observed by the caller after release
      await waitForLockWaiters(prisma, 'auth_sessions', contenders);
    },
    { timeout: 20_000 },
  );
  return started;
}

/**
 * Runs `body` in a transaction that is then ROLLED BACK — for holding a lock or
 * an uncommitted row (which blocks a competing INSERT on a unique key) while
 * other transactions are started and observed waiting on it.
 */
export async function inRolledBackTransaction(
  prisma: PrismaClient,
  body: (tx: Prisma.TransactionClient) => Promise<void>,
): Promise<void> {
  const release = new Error('release');
  await prisma
    .$transaction(
      async (tx) => {
        await body(tx);
        throw release;
      },
      { timeout: 20_000 },
    )
    .catch((error) => {
      if (error !== release) throw error;
    });
}

export async function waitForLockWaiters(prisma: PrismaClient, table: string, expected: number): Promise<void> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const [{ waiting }] = await prisma.$queryRaw<Array<{ waiting: number }>>`
      SELECT count(*)::int AS waiting
      FROM pg_stat_activity
      WHERE datname = current_database()
        AND wait_event_type = 'Lock'
        AND query LIKE ${'%' + table + '%'}`;
    if (waiting >= expected) return;
    if (Date.now() > deadline) throw new Error(`only ${waiting}/${expected} transactions reached the ${table} lock`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
