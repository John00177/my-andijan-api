import { ConflictException } from '@nestjs/common';
import { BusinessStatus, ClaimStatus, PrismaClient, UserRole } from '@prisma/client';
import { AdminService } from '../../src/admin/admin.service';
import { OwnerService } from '../../src/owner/owner.service';
import {
  claimableListing,
  createTestPrisma,
  createUser,
  raceAtBusinessLock,
  resetDatabase,
  schemaDriftExitCode,
  services,
  testDatabaseUrl,
} from './support';

// Phase 16H — business-claim concurrency against REAL PostgreSQL.
// One PENDING claim per (business, claimant) is a database guarantee (partial
// unique index), not just a service pre-check; competing claims from different
// people stay allowed; and a claim filed while another is being approved never
// survives as PENDING on a listing that now has an owner.
//
// Races are forced, not left to timing: a test transaction holds the business
// row FOR UPDATE until every contender is observed blocked on it.
// The migration itself, applied on top of existing duplicates, is covered by
// migration-claims-pending-unique.db-spec.ts.

type Claimant = { id: number; phone: string; role: UserRole };

describe('Business claims under concurrency on PostgreSQL (Phase 16H)', () => {
  let prisma: PrismaClient;
  let owner: OwnerService;
  let admin: AdminService;
  let phoneSeq = 0;
  const nextPhone = () => `+99893${String(1000000 + ++phoneSeq).slice(-7)}`;

  const fileClaim = (user: Claimant, businessId: number) =>
    owner.createClaim({ id: user.id, phone: user.phone, role: user.role } as Parameters<OwnerService['createClaim']>[0], {
      businessId,
    });
  const claimsFor = (businessId: number) =>
    prisma.businessClaim.findMany({ where: { businessId }, orderBy: { id: 'asc' } });
  const claimAudits = () => prisma.auditLog.count({ where: { entityType: 'BusinessClaim', action: 'CREATE' } });

  beforeAll(() => {
    prisma = createTestPrisma();
    ({ owner, admin } = services(prisma));
  });

  beforeEach(async () => {
    await resetDatabase(prisma);
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('the migrated database carries the partial unique index, and still matches schema.prisma', async () => {
    const [index] = await prisma.$queryRaw<Array<{ indexdef: string }>>`
      SELECT indexdef FROM pg_indexes
      WHERE tablename = 'business_claims' AND indexname = 'business_claims_one_pending_per_claimant'`;
    expect(index.indexdef).toMatch(
      /CREATE UNIQUE INDEX .* \(business_id, claimant_id\) WHERE \(status = 'PENDING'::"ClaimStatus"\)/,
    );
    // Prisma cannot model a partial index, and its drift detection skips them
    // (schema engine: `indpred IS NULL`), so the schema and database still agree.
    expect(schemaDriftExitCode(testDatabaseUrl())).toBe(0);
  });

  it('ten simultaneous submissions by one claimant file exactly one claim; the other nine get the 409', async () => {
    const business = await claimableListing(prisma, 'soy-milliy');
    const claimant = await createUser(prisma, nextPhone());

    const results = await raceAtBusinessLock(prisma, business.id, 10, () =>
      Promise.allSettled(Array.from({ length: 10 }, () => fileClaim(claimant, business.id))),
    );

    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(rejected).toHaveLength(9);
    for (const { reason } of rejected) {
      expect(reason).toBeInstanceOf(ConflictException);
      expect((reason as ConflictException).message).toBe('You already have a pending claim for this business');
    }
    const claims = await claimsFor(business.id);
    expect(claims.map((c) => [c.claimantId, c.status])).toEqual([[claimant.id, ClaimStatus.PENDING]]);
    expect(await claimAudits()).toBe(1); // the losers' audit rows rolled back with them
  });

  it('competing claims from different people are still all filed', async () => {
    const business = await claimableListing(prisma, 'huzur-kafe');
    const claimants = await Promise.all(Array.from({ length: 5 }, () => createUser(prisma, nextPhone())));

    const results = await raceAtBusinessLock(prisma, business.id, 5, () =>
      Promise.allSettled(claimants.map((c) => fileClaim(c, business.id))),
    );

    expect(results.every((r) => r.status === 'fulfilled')).toBe(true);
    const claims = await claimsFor(business.id);
    expect(claims).toHaveLength(5);
    expect(new Set(claims.map((c) => c.claimantId))).toEqual(new Set(claimants.map((c) => c.id)));
    expect(claims.every((c) => c.status === ClaimStatus.PENDING)).toBe(true);
  });

  it('the database itself refuses a second PENDING row for the same pair, but not history', async () => {
    const business = await claimableListing(prisma, 'kok-choy');
    const claimant = await createUser(prisma, nextPhone());
    const pair = { businessId: business.id, claimantId: claimant.id };

    await prisma.businessClaim.create({ data: { ...pair, status: ClaimStatus.REJECTED } });
    await prisma.businessClaim.create({ data: { ...pair, status: ClaimStatus.REJECTED } });
    await prisma.businessClaim.create({ data: pair }); // PENDING
    await expect(prisma.businessClaim.create({ data: pair })).rejects.toMatchObject({ code: 'P2002' });
  });

  it('a rejected claimant can file again', async () => {
    const business = await claimableListing(prisma, 'andijon-non');
    const claimant = await createUser(prisma, nextPhone());
    const staff = await createUser(prisma, nextPhone(), UserRole.ADMIN);

    const first = await fileClaim(claimant, business.id);
    await admin.rejectClaim(first.id, staff.id, { reason: 'No proof attached' });
    const second = await fileClaim(claimant, business.id);

    expect(second.id).not.toBe(first.id);
    expect((await claimsFor(business.id)).map((c) => c.status)).toEqual([ClaimStatus.REJECTED, ClaimStatus.PENDING]);
  });

  it('a claim racing an approval never stays PENDING on the listing that just got an owner', async () => {
    const business = await claimableListing(prisma, 'bozor-choyxona');
    const winner = await createUser(prisma, nextPhone());
    const latecomer = await createUser(prisma, nextPhone());
    const staff = await createUser(prisma, nextPhone(), UserRole.ADMIN);
    const winning = await fileClaim(winner, business.id);

    // Both block on the business row: the approval at its owner UPDATE, the
    // new claim at its FOR SHARE re-check. Whichever proceeds first, the
    // outcome must be consistent.
    const [approval, late] = await raceAtBusinessLock(prisma, business.id, 2, () =>
      Promise.allSettled([
        admin.approveClaim(winning.id, staff.id, { verificationNote: 'Called the listed phone' }),
        fileClaim(latecomer, business.id),
      ]),
    );

    expect(approval.status).toBe('fulfilled');
    const listing = await prisma.business.findUniqueOrThrow({ where: { id: business.id } });
    expect(listing).toMatchObject({ ownerId: winner.id, status: BusinessStatus.APPROVED });
    const claims = await claimsFor(business.id);
    expect(claims.filter((c) => c.status === ClaimStatus.PENDING)).toEqual([]);
    if (late.status === 'rejected') {
      // The approval committed first: the late claim was refused, nothing written.
      expect(late.reason).toBeInstanceOf(ConflictException);
      expect(claims.map((c) => c.claimantId)).toEqual([winner.id]);
    } else {
      // The late claim committed first: the approval closed it as moot.
      const lateClaim = claims.find((c) => c.claimantId === latecomer.id)!;
      expect(lateClaim.status).toBe(ClaimStatus.REJECTED);
      expect(lateClaim.rejectionReason).toBe('Another claim for this business was approved');
    }
  });
});
