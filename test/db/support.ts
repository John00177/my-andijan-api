import { JwtService } from '@nestjs/jwt';
import { PrismaClient, UserRole } from '@prisma/client';
import * as bcrypt from 'bcrypt';
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

export function createTestPrisma(log = false): PrismaClient {
  return new PrismaClient({
    datasources: { db: { url: testDatabaseUrl() } },
    ...(log ? { log: [{ emit: 'event' as const, level: 'query' as const }] } : {}),
  });
}

export async function resetDatabase(prisma: PrismaClient): Promise<void> {
  await prisma.$executeRawUnsafe(
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
