import { ClaimStatus, PrismaClient } from '@prisma/client';
import { rmSync } from 'fs';
import {
  claimableListing,
  createTestPrisma,
  createUser,
  deployMigrations,
  migrationsWorkDir,
  recreateDatabase,
  schemaDriftExitCode,
  scratchDatabaseUrl,
} from './support';

// Phase 16H migration — the pending-claim partial unique index, applied the way
// production gets it: `prisma migrate deploy` on a database at the previous
// schema that may already hold duplicates the old check-then-insert race
// produced. Uses its own throwaway database (<test db>_claims16h).

const MIGRATION = '20261007090000_phase16h_claim_pending_unique';

describe(`Migration ${MIGRATION} on existing data`, () => {
  let admin: PrismaClient;
  let db: PrismaClient;
  const workDirs: string[] = [];
  const { url: dbUrl, name: dbName } = scratchDatabaseUrl('claims16h');

  const deployThrough = (predicate: (m: string) => boolean) => {
    const dir = migrationsWorkDir(predicate);
    workDirs.push(dir);
    if (!deployMigrations(dir, dbUrl).ok) throw new Error('prisma migrate deploy failed on the scratch database');
  };

  beforeAll(async () => {
    admin = createTestPrisma();
    await recreateDatabase(admin, dbName);
    deployThrough((m) => m < MIGRATION);
    // The migration adds no column, so the current client can seed the previous schema.
    db = new PrismaClient({ datasources: { db: { url: dbUrl } } });
  });

  afterAll(async () => {
    await db?.$disconnect();
    await admin?.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
    await admin?.$disconnect();
    for (const dir of workDirs) rmSync(dir, { recursive: true, force: true });
  });

  it('closes duplicate PENDING claims (keeping the earliest), touches nothing else, then enforces uniqueness', async () => {
    const business = await claimableListing(db, 'dup-listing');
    const a = await createUser(db, '+998930000001');
    const b = await createUser(db, '+998930000002');
    const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000);
    const seed = (claimantId: number, status: ClaimStatus, createdAt: Date) =>
      db.businessClaim.create({ data: { businessId: business.id, claimantId, status, createdAt } });

    const firstAt = minutesAgo(30);
    const aFirst = await seed(a.id, ClaimStatus.PENDING, firstAt);
    const aSameInstant = await seed(a.id, ClaimStatus.PENDING, firstAt); // tie: the lower id counts as earlier
    const aLater = await seed(a.id, ClaimStatus.PENDING, minutesAgo(5));
    const aHistory = await seed(a.id, ClaimStatus.REJECTED, minutesAgo(60));
    const bCompeting = await seed(b.id, ClaimStatus.PENDING, minutesAgo(10)); // another person: not a duplicate

    deployThrough((m) => m <= MIGRATION);

    const after = new Map((await db.businessClaim.findMany()).map((c) => [c.id, c]));
    expect(after.size).toBe(5); // nothing deleted
    expect(after.get(aFirst.id)).toEqual(aFirst);
    for (const dup of [aSameInstant, aLater]) {
      expect(after.get(dup.id)).toMatchObject({
        status: ClaimStatus.REJECTED,
        rejectionReason: 'Duplicate of an earlier pending claim by the same user (closed automatically)',
        reviewedById: null,
        reviewedAt: expect.any(Date),
      });
    }
    expect(after.get(aHistory.id)).toEqual(aHistory);
    expect(after.get(bCompeting.id)).toEqual(bCompeting);

    // From now on the database refuses the duplicate itself.
    await expect(
      db.businessClaim.create({ data: { businessId: business.id, claimantId: a.id } }),
    ).rejects.toMatchObject({ code: 'P2002' });
    expect(schemaDriftExitCode(dbUrl)).toBe(0);
  });
});
