import { ForbiddenException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { BusinessStatus, ClaimStatus, EventStatus, ReportStatus, ReviewStatus } from '@prisma/client';
import { AdminService } from './admin.service';
import { PrismaService } from '../prisma/prisma.service';
import { ReviewsService } from '../reviews/reviews.service';
import { BusinessesService } from '../businesses/businesses.service';
import { OwnerService } from '../owner/owner.service';
import { ReportResolveAction } from './dto/report.dto';

// Conflict of interest (Phase 15D, D-75): a staff member may hold the
// capability for an action and still be refused on a record that is theirs —
// their own listing, their own claim, a review they wrote or one about their
// business, a report that involves them. Every refusal happens before any
// write. Each case is paired with the same action on someone else's record.
const ACTOR = 42;
const OTHER = 99;

describe('AdminService — conflict-of-interest refusals', () => {
  let service: AdminService;
  let prisma: Record<string, Record<string, jest.Mock>> & { $transaction: jest.Mock };

  beforeEach(async () => {
    prisma = {
      $transaction: jest.fn((fn: (tx: unknown) => unknown) => fn(prisma)),
      business: {
        findFirst: jest.fn(),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        update: jest.fn().mockResolvedValue({ id: 5 }),
        findUniqueOrThrow: jest.fn().mockResolvedValue({ id: 5, status: BusinessStatus.APPROVED }),
      },
      branch: { findFirst: jest.fn().mockResolvedValue({ id: 50 }), update: jest.fn().mockResolvedValue({ id: 50 }) },
      businessClaim: { findUnique: jest.fn(), updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      review: { findFirst: jest.fn(), updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      reviewReport: { findUnique: jest.fn(), updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      event: { findFirst: jest.fn(), update: jest.fn().mockResolvedValue({ id: 3 }) },
      user: { findUnique: jest.fn() },
      notification: { create: jest.fn() },
      auditLog: { create: jest.fn() },
    } as never;
    const moduleRef = await Test.createTestingModule({
      providers: [
        AdminService,
        { provide: PrismaService, useValue: prisma },
        { provide: ReviewsService, useValue: { recalculateAggregates: jest.fn() } },
      ],
    }).compile();
    service = moduleRef.get(AdminService);
  });

  const ownBusiness = (status: BusinessStatus = BusinessStatus.APPROVED) => ({
    id: 5,
    ownerId: ACTOR,
    status,
    isVerified: false,
    isPromoted: true,
    deletedAt: null,
  });

  const businessActions: Array<[string, () => Promise<unknown>, BusinessStatus]> = [
    ['approve', () => service.approveBusiness(5, ACTOR), BusinessStatus.PENDING],
    ['reject', () => service.rejectBusiness(5, ACTOR, { reason: 'x' }), BusinessStatus.PENDING],
    ['verify', () => service.verifyBusiness(5, ACTOR), BusinessStatus.APPROVED],
    ['suspend', () => service.suspendBusiness(5, ACTOR, { reason: 'x' }), BusinessStatus.APPROVED],
    ['unsuspend', () => service.unsuspendBusiness(5, ACTOR), BusinessStatus.SUSPENDED],
    ['promote', () => service.promoteBusiness(5, ACTOR, { until: '2099-01-01' }), BusinessStatus.APPROVED],
    ['unpromote', () => service.unpromoteBusiness(5, ACTOR), BusinessStatus.APPROVED],
    ['hide', () => service.hideBusiness(5, ACTOR), BusinessStatus.APPROVED],
    ['unhide', () => service.unhideBusiness(5, ACTOR), BusinessStatus.HIDDEN],
    ['admin edit', () => service.updateBusiness(5, ACTOR, { reason: 'x', name: 'Mine' }), BusinessStatus.APPROVED],
    ['admin hours', () => service.updateBusinessHours(5, ACTOR, 'x', []), BusinessStatus.APPROVED],
    ['admin branch', () => service.updateBusinessBranch(5, ACTOR, { reason: 'x', phone: '+998901234567' }), BusinessStatus.APPROVED],
  ];

  it.each(businessActions)('refuses to %s a listing the actor owns, writing nothing', async (_name, run, status) => {
    prisma.business.findFirst.mockResolvedValue(ownBusiness(status));
    await expect(run()).rejects.toThrow(ForbiddenException);
    expect(prisma.business.updateMany).not.toHaveBeenCalled();
    expect(prisma.business.update).not.toHaveBeenCalled();
    expect(prisma.branch.update).not.toHaveBeenCalled();
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });

  it("still approves someone else's listing (control)", async () => {
    prisma.business.findFirst.mockResolvedValue({ ...ownBusiness(BusinessStatus.PENDING), ownerId: OTHER });
    prisma.user.findUnique.mockResolvedValue({ id: OTHER, role: 'BUSINESS_OWNER' });
    await expect(service.approveBusiness(5, ACTOR)).resolves.toBeDefined();
  });

  it("refuses to decide the actor's own claim (approve and reject)", async () => {
    prisma.businessClaim.findUnique.mockResolvedValue({ id: 1, claimantId: ACTOR, businessId: 5, status: ClaimStatus.PENDING });
    await expect(service.approveClaim(1, ACTOR, { verificationNote: 'x' })).rejects.toThrow(ForbiddenException);
    await expect(service.rejectClaim(1, ACTOR, { reason: 'x' })).rejects.toThrow(ForbiddenException);
    expect(prisma.business.updateMany).not.toHaveBeenCalled();
    expect(prisma.businessClaim.updateMany).not.toHaveBeenCalled();
  });

  const review = (userId: number, ownerId: number) => ({
    id: 3,
    userId,
    branchId: 50,
    status: ReviewStatus.PUBLISHED,
    branch: { business: { ownerId } },
  });

  it.each([
    ['the actor wrote', review(ACTOR, OTHER)],
    ["is about the actor's business", review(OTHER, ACTOR)],
  ])('refuses to hide a review that %s', async (_why, row) => {
    prisma.review.findFirst.mockResolvedValue(row);
    await expect(service.hideReview(3, ACTOR)).rejects.toThrow(ForbiddenException);
    expect(prisma.review.updateMany).not.toHaveBeenCalled();
  });

  it("refuses to restore a hidden review about the actor's business", async () => {
    prisma.review.findFirst.mockResolvedValue({ ...review(OTHER, ACTOR), status: ReviewStatus.HIDDEN });
    await expect(service.restoreReview(3, ACTOR)).rejects.toThrow(ForbiddenException);
    expect(prisma.review.updateMany).not.toHaveBeenCalled();
  });

  it.each([
    ['the actor filed', { reporterId: ACTOR, author: OTHER, owner: 7 }],
    ["is about the actor's review", { reporterId: OTHER, author: ACTOR, owner: 7 }],
    ["is about the actor's business", { reporterId: OTHER, author: 8, owner: ACTOR }],
  ])('refuses to resolve a report that %s', async (_why, r) => {
    prisma.reviewReport.findUnique.mockResolvedValue({
      id: 9,
      status: ReportStatus.PENDING,
      reporterId: r.reporterId,
      review: { id: 3, userId: r.author, branch: { business: { ownerId: r.owner } } },
    });
    await expect(service.resolveReport(9, ACTOR, { action: ReportResolveAction.DISMISS })).rejects.toThrow(
      ForbiddenException,
    );
    expect(prisma.reviewReport.updateMany).not.toHaveBeenCalled();
  });

  it("refuses to approve or reject an event of the actor's own business", async () => {
    prisma.event.findFirst.mockResolvedValue({ id: 3, status: EventStatus.PENDING, business: { ownerId: ACTOR } });
    await expect(service.approveEvent(3, ACTOR)).rejects.toThrow(ForbiddenException);
    await expect(service.rejectEvent(3, ACTOR, { reason: 'x' })).rejects.toThrow(ForbiddenException);
    expect(prisma.event.update).not.toHaveBeenCalled();
  });
});

describe('BusinessesService.remove — conflict of interest', () => {
  it('refuses to soft-delete a listing the actor owns', async () => {
    const prisma: { $transaction: jest.Mock; business: Record<string, jest.Mock>; auditLog: Record<string, jest.Mock> } = {
      $transaction: jest.fn((fn: (tx: unknown) => unknown): unknown => fn(prisma)),
      business: { findFirst: jest.fn().mockResolvedValue({ id: 5, ownerId: ACTOR }), update: jest.fn() },
      auditLog: { create: jest.fn() },
    };
    const moduleRef = await Test.createTestingModule({
      providers: [BusinessesService, { provide: PrismaService, useValue: prisma }, { provide: OwnerService, useValue: {} }],
    }).compile();
    await expect(moduleRef.get(BusinessesService).remove(5, ACTOR)).rejects.toThrow(ForbiddenException);
    expect(prisma.business.update).not.toHaveBeenCalled();
  });
});
