import { ConflictException, NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AuditAction, BusinessStatus, ReviewStatus, UserRole } from '@prisma/client';
import { AdminService } from './admin.service';
import { PrismaService } from '../prisma/prisma.service';
import { ReviewsService } from '../reviews/reviews.service';

const ACTOR_ID = 42;
const NON_HIDDEN = [
  BusinessStatus.APPROVED,
  BusinessStatus.PENDING,
  BusinessStatus.SUSPENDED,
  BusinessStatus.REJECTED,
  BusinessStatus.DRAFT,
];

describe('AdminService — Phase 14 moderation & restoration', () => {
  let service: AdminService;
  let reviewsService: { recalculateAggregates: jest.Mock };
  let prisma: {
    $transaction: jest.Mock;
    business: { findFirst: jest.Mock; updateMany: jest.Mock; findUniqueOrThrow: jest.Mock; findMany: jest.Mock; count: jest.Mock };
    user: { findUnique: jest.Mock; update: jest.Mock };
    notification: { create: jest.Mock };
    review: { findFirst: jest.Mock; updateMany: jest.Mock; findUniqueOrThrow: jest.Mock };
    reviewReport: { findMany: jest.Mock; count: jest.Mock };
    auditLog: { create: jest.Mock };
  };

  function business(overrides: Record<string, unknown> = {}) {
    return { id: 5, name: 'Soy', ownerId: null, status: BusinessStatus.APPROVED, statusBeforeHide: null, deletedAt: null, ...overrides };
  }

  /** The business row as the last compare-and-set wrote it. */
  function afterLastUpdate(base: Record<string, unknown>) {
    const data = prisma.business.updateMany.mock.calls.at(-1)?.[0].data ?? {};
    return Promise.resolve({ ...base, ...data });
  }

  beforeEach(async () => {
    prisma = {
      $transaction: jest.fn((arg: unknown) =>
        typeof arg === 'function' ? (arg as (tx: unknown) => unknown)(prisma) : Promise.all(arg as Promise<unknown>[]),
      ),
      business: {
        findFirst: jest.fn(),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        findUniqueOrThrow: jest.fn(),
        findMany: jest.fn().mockResolvedValue([]),
        count: jest.fn().mockResolvedValue(0),
      },
      user: { findUnique: jest.fn(), update: jest.fn() },
      notification: { create: jest.fn() },
      review: { findFirst: jest.fn(), updateMany: jest.fn().mockResolvedValue({ count: 1 }), findUniqueOrThrow: jest.fn() },
      reviewReport: { findMany: jest.fn().mockResolvedValue([]), count: jest.fn().mockResolvedValue(0) },
      auditLog: { create: jest.fn() },
    };
    reviewsService = { recalculateAggregates: jest.fn() };

    const moduleRef = await Test.createTestingModule({
      providers: [
        AdminService,
        { provide: PrismaService, useValue: prisma },
        { provide: ReviewsService, useValue: reviewsService },
      ],
    }).compile();
    service = moduleRef.get(AdminService);
  });

  // ---------------------------------------------------------------------------
  describe('PII shaping by viewer role (D-72)', () => {
    const query = { page: 1, limit: 20 } as never;

    it('gives a MODERATOR the business owner without phone or email', async () => {
      await service.findBusinesses(query, UserRole.MODERATOR);
      const { include } = prisma.business.findMany.mock.calls[0][0];
      expect(include.owner).toEqual({ select: { id: true, fullName: true } });
    });

    it.each([UserRole.ADMIN, UserRole.SUPER_ADMIN])('gives %s the owner contact details', async (role) => {
      await service.findBusinesses(query, role);
      const { include } = prisma.business.findMany.mock.calls[0][0];
      expect(include.owner).toEqual({ select: { id: true, fullName: true, phone: true, email: true } });
    });

    it('gives a MODERATOR only the reporter id on review reports', async () => {
      await service.findReports(query, UserRole.MODERATOR);
      const { include } = prisma.reviewReport.findMany.mock.calls[0][0];
      expect(include.reporter).toEqual({ select: { id: true } });
    });

    it.each([UserRole.ADMIN, UserRole.SUPER_ADMIN])('gives %s the reporter name', async (role) => {
      await service.findReports(query, role);
      const { include } = prisma.reviewReport.findMany.mock.calls[0][0];
      expect(include.reporter).toEqual({ select: { id: true, fullName: true } });
    });
  });

  // ---------------------------------------------------------------------------
  describe('approve / reject are compare-and-set on PENDING', () => {
    beforeEach(() => {
      prisma.business.findFirst.mockResolvedValue(business({ status: BusinessStatus.PENDING }));
      prisma.business.findUniqueOrThrow.mockImplementation(() => afterLastUpdate(business()));
    });

    it('approves only while still PENDING', async () => {
      const result = await service.approveBusiness(5, ACTOR_ID);

      expect(result.status).toBe(BusinessStatus.APPROVED);
      expect(prisma.business.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 5, status: BusinessStatus.PENDING, deletedAt: null } }),
      );
    });

    it('409s an approval that loses the race to another moderator — no audit, no owner promotion', async () => {
      prisma.business.findFirst.mockResolvedValue(business({ status: BusinessStatus.PENDING, ownerId: 9 }));
      prisma.business.updateMany.mockResolvedValue({ count: 0 });

      await expect(service.approveBusiness(5, ACTOR_ID)).rejects.toBeInstanceOf(ConflictException);
      expect(prisma.auditLog.create).not.toHaveBeenCalled();
      expect(prisma.user.update).not.toHaveBeenCalled();
      expect(prisma.notification.create).not.toHaveBeenCalled();
    });

    it('rejects only while still PENDING, and 409s a lost race', async () => {
      await expect(service.rejectBusiness(5, ACTOR_ID, { reason: 'Spam' })).resolves.toMatchObject({
        status: BusinessStatus.REJECTED,
      });

      prisma.business.updateMany.mockResolvedValue({ count: 0 });
      await expect(service.rejectBusiness(5, ACTOR_ID, { reason: 'Spam' })).rejects.toBeInstanceOf(ConflictException);
    });
  });

  // ---------------------------------------------------------------------------
  describe('hide records the prior status (D-73)', () => {
    it.each(NON_HIDDEN)('hiding a %s business stores it in statusBeforeHide', async (status) => {
      prisma.business.findFirst.mockResolvedValue(business({ status }));
      prisma.business.findUniqueOrThrow.mockImplementation(() => afterLastUpdate(business({ status })));

      const result = await service.hideBusiness(5, ACTOR_ID);

      expect(result.status).toBe(BusinessStatus.HIDDEN);
      expect(prisma.business.updateMany).toHaveBeenCalledWith({
        where: { id: 5, status, deletedAt: null },
        data: { status: BusinessStatus.HIDDEN, statusBeforeHide: status },
      });
      expect(prisma.auditLog.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          action: AuditAction.UPDATE,
          before: { status },
          after: { status: BusinessStatus.HIDDEN, statusBeforeHide: status },
        }),
      });
    });

    it('409s hiding an already hidden business', async () => {
      prisma.business.findFirst.mockResolvedValue(business({ status: BusinessStatus.HIDDEN }));
      await expect(service.hideBusiness(5, ACTOR_ID)).rejects.toBeInstanceOf(ConflictException);
    });

    it('409s when the status changed between read and write', async () => {
      prisma.business.findFirst.mockResolvedValue(business());
      prisma.business.updateMany.mockResolvedValue({ count: 0 });
      await expect(service.hideBusiness(5, ACTOR_ID)).rejects.toBeInstanceOf(ConflictException);
      expect(prisma.auditLog.create).not.toHaveBeenCalled();
    });

    it('404s an unknown business', async () => {
      prisma.business.findFirst.mockResolvedValue(null);
      await expect(service.hideBusiness(404, ACTOR_ID)).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  // ---------------------------------------------------------------------------
  describe('unhide restores the recorded status, else PENDING (D-73)', () => {
    function hidden(statusBeforeHide: BusinessStatus | null) {
      const row = business({ status: BusinessStatus.HIDDEN, statusBeforeHide });
      prisma.business.findFirst.mockResolvedValue(row);
      prisma.business.findUniqueOrThrow.mockImplementation(() => afterLastUpdate(row));
    }

    it.each(NON_HIDDEN)('restores a business hidden from %s to exactly that status', async (status) => {
      hidden(status);

      const result = await service.unhideBusiness(5, ACTOR_ID);

      expect(result.status).toBe(status);
      expect(prisma.business.updateMany).toHaveBeenCalledWith({
        where: { id: 5, status: BusinessStatus.HIDDEN, deletedAt: null },
        data: { status, statusBeforeHide: null },
      });
      expect(prisma.auditLog.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          action: AuditAction.RESTORE,
          before: { status: BusinessStatus.HIDDEN, statusBeforeHide: status },
          after: { status, restoredFrom: 'statusBeforeHide' },
        }),
      });
    });

    it('falls back to PENDING (re-review) when no prior status was recorded — never guesses APPROVED', async () => {
      hidden(null);

      const result = await service.unhideBusiness(5, ACTOR_ID);

      expect(result.status).toBe(BusinessStatus.PENDING);
      expect(prisma.auditLog.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          after: { status: BusinessStatus.PENDING, restoredFrom: 'fallback:PENDING' },
        }),
      });
    });

    it('treats a corrupt recorded HIDDEN as unknown and falls back to PENDING', async () => {
      hidden(BusinessStatus.HIDDEN);
      await expect(service.unhideBusiness(5, ACTOR_ID)).resolves.toMatchObject({ status: BusinessStatus.PENDING });
    });

    it.each(NON_HIDDEN)('409s unhiding a business that is %s (not hidden)', async (status) => {
      prisma.business.findFirst.mockResolvedValue(business({ status }));
      await expect(service.unhideBusiness(5, ACTOR_ID)).rejects.toBeInstanceOf(ConflictException);
      expect(prisma.business.updateMany).not.toHaveBeenCalled();
    });

    it('409s when a concurrent unhide wins first', async () => {
      hidden(BusinessStatus.APPROVED);
      prisma.business.updateMany.mockResolvedValue({ count: 0 });
      await expect(service.unhideBusiness(5, ACTOR_ID)).rejects.toBeInstanceOf(ConflictException);
      expect(prisma.auditLog.create).not.toHaveBeenCalled();
    });

    it('404s an unknown or deleted business', async () => {
      prisma.business.findFirst.mockResolvedValue(null);
      await expect(service.unhideBusiness(404, ACTOR_ID)).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  // ---------------------------------------------------------------------------
  describe('review hide / restore are compare-and-set', () => {
    const review = { id: 11, branchId: 2, status: ReviewStatus.PUBLISHED, deletedAt: null };

    it('hides only while the review is still in the status that was read', async () => {
      prisma.review.findFirst.mockResolvedValue(review);
      prisma.review.findUniqueOrThrow.mockResolvedValue({ ...review, status: ReviewStatus.HIDDEN });

      await expect(service.hideReview(11, ACTOR_ID)).resolves.toMatchObject({ status: ReviewStatus.HIDDEN });
      expect(prisma.review.updateMany).toHaveBeenCalledWith({
        where: { id: 11, status: ReviewStatus.PUBLISHED, deletedAt: null },
        data: { status: ReviewStatus.HIDDEN },
      });
      expect(reviewsService.recalculateAggregates).toHaveBeenCalledWith(2, prisma);
    });

    it('409s a hide that loses the race — no audit, no aggregate recalculation', async () => {
      prisma.review.findFirst.mockResolvedValue(review);
      prisma.review.updateMany.mockResolvedValue({ count: 0 });

      await expect(service.hideReview(11, ACTOR_ID)).rejects.toBeInstanceOf(ConflictException);
      expect(prisma.auditLog.create).not.toHaveBeenCalled();
      expect(reviewsService.recalculateAggregates).not.toHaveBeenCalled();
    });

    it('409s a restore that loses the race', async () => {
      prisma.review.findFirst.mockResolvedValue({ ...review, status: ReviewStatus.HIDDEN });
      prisma.review.updateMany.mockResolvedValue({ count: 0 });

      await expect(service.restoreReview(11, ACTOR_ID)).rejects.toBeInstanceOf(ConflictException);
    });
  });
});
