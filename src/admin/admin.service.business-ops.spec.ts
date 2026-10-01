import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AuditAction, BusinessStatus, ReportStatus, ReviewStatus } from '@prisma/client';
import { AdminService } from './admin.service';
import { ReportResolveAction } from './dto/report.dto';
import { PrismaService } from '../prisma/prisma.service';
import { ReviewsService } from '../reviews/reviews.service';

const ADMIN_ID = 99;

describe('AdminService — business operations', () => {
  let service: AdminService;
  let reviewsService: { recalculateAggregates: jest.Mock };
  let prisma: {
    $transaction: jest.Mock;
    business: { findFirst: jest.Mock; update: jest.Mock; updateMany: jest.Mock; findUniqueOrThrow: jest.Mock };
    reviewReport: { findUnique: jest.Mock; update: jest.Mock };
    review: { update: jest.Mock };
    auditLog: { create: jest.Mock };
  };

  function business(overrides: Record<string, unknown> = {}) {
    return {
      id: 5,
      status: BusinessStatus.APPROVED,
      isVerified: false,
      isPromoted: false,
      promotedUntil: null,
      rejectionReason: null,
      deletedAt: null,
      ...overrides,
    };
  }

  beforeEach(async () => {
    prisma = {
      $transaction: jest.fn((arg: unknown) => (arg as (tx: unknown) => unknown)(prisma)),
      business: {
        findFirst: jest.fn(),
        update: jest.fn(({ data }) => Promise.resolve(business(data))),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        findUniqueOrThrow: jest.fn(),
      },
      reviewReport: { findUnique: jest.fn(), update: jest.fn(({ data }) => Promise.resolve({ id: 3, ...data })) },
      review: { update: jest.fn(({ data }) => Promise.resolve({ id: 11, ...data })) },
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

  // --------------------------------------------------------------------------
  describe('verifyBusiness / unverifyBusiness', () => {
    it('verifies an unverified business and audits it', async () => {
      prisma.business.findFirst.mockResolvedValue(business());

      const result = await service.verifyBusiness(5, ADMIN_ID);

      expect(result.isVerified).toBe(true);
      expect(prisma.business.update).toHaveBeenCalledWith({
        where: { id: 5 },
        data: expect.objectContaining({ isVerified: true, verifiedById: ADMIN_ID }),
      });
      expect(prisma.auditLog.create).toHaveBeenCalled();
    });

    it('refuses to verify an already-verified business (409)', async () => {
      prisma.business.findFirst.mockResolvedValue(business({ isVerified: true }));
      await expect(service.verifyBusiness(5, ADMIN_ID)).rejects.toBeInstanceOf(ConflictException);
      expect(prisma.business.update).not.toHaveBeenCalled();
    });

    it('404s verifying a nonexistent business', async () => {
      prisma.business.findFirst.mockResolvedValue(null);
      await expect(service.verifyBusiness(404, ADMIN_ID)).rejects.toBeInstanceOf(NotFoundException);
    });

    it('unverifies a verified business, clearing only isVerified', async () => {
      prisma.business.findFirst.mockResolvedValue(business({ isVerified: true }));

      const result = await service.unverifyBusiness(5, ADMIN_ID);

      expect(result.isVerified).toBe(false);
      // verifiedAt/verifiedById double as the approval record — untouched.
      expect(prisma.business.update).toHaveBeenCalledWith({ where: { id: 5 }, data: { isVerified: false } });
      expect(prisma.auditLog.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ action: AuditAction.UPDATE, entityType: 'Business', entityId: 5, actorId: ADMIN_ID }),
      });
    });

    it('refuses to unverify a business that is not verified (409)', async () => {
      prisma.business.findFirst.mockResolvedValue(business({ isVerified: false }));
      await expect(service.unverifyBusiness(5, ADMIN_ID)).rejects.toBeInstanceOf(ConflictException);
      expect(prisma.business.update).not.toHaveBeenCalled();
    });

    it('404s unverifying a nonexistent business', async () => {
      prisma.business.findFirst.mockResolvedValue(null);
      await expect(service.unverifyBusiness(404, ADMIN_ID)).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  // --------------------------------------------------------------------------
  describe('suspendBusiness / unsuspendBusiness', () => {
    it('suspends an APPROVED business with a compare-and-set update and records the reason', async () => {
      prisma.business.findFirst.mockResolvedValue(business());
      prisma.business.findUniqueOrThrow.mockResolvedValue(
        business({ status: BusinessStatus.SUSPENDED, rejectionReason: 'Spam' }),
      );

      const result = await service.suspendBusiness(5, ADMIN_ID, { reason: 'Spam' });

      expect(result.status).toBe(BusinessStatus.SUSPENDED);
      expect(prisma.business.updateMany).toHaveBeenCalledWith({
        where: { id: 5, status: BusinessStatus.APPROVED, deletedAt: null },
        data: { status: BusinessStatus.SUSPENDED, rejectionReason: 'Spam' },
      });
      expect(prisma.auditLog.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ action: AuditAction.SUSPEND, entityId: 5 }),
      });
    });

    it('refuses to suspend an already-suspended business (409)', async () => {
      prisma.business.findFirst.mockResolvedValue(business({ status: BusinessStatus.SUSPENDED }));
      await expect(service.suspendBusiness(5, ADMIN_ID, { reason: 'x' })).rejects.toBeInstanceOf(ConflictException);
    });

    it.each([BusinessStatus.PENDING, BusinessStatus.REJECTED, BusinessStatus.HIDDEN, BusinessStatus.DRAFT])(
      'refuses to suspend a %s business — only live listings can be suspended (409)',
      async (status) => {
        prisma.business.findFirst.mockResolvedValue(business({ status }));
        await expect(service.suspendBusiness(5, ADMIN_ID, { reason: 'x' })).rejects.toBeInstanceOf(ConflictException);
        expect(prisma.business.updateMany).not.toHaveBeenCalled();
      },
    );

    it('fails with 409 when a concurrent transition wins the compare-and-set', async () => {
      prisma.business.findFirst.mockResolvedValue(business());
      prisma.business.updateMany.mockResolvedValue({ count: 0 });
      await expect(service.suspendBusiness(5, ADMIN_ID, { reason: 'x' })).rejects.toBeInstanceOf(ConflictException);
      expect(prisma.auditLog.create).not.toHaveBeenCalled();
    });

    it('404s suspending a nonexistent business', async () => {
      prisma.business.findFirst.mockResolvedValue(null);
      await expect(service.suspendBusiness(404, ADMIN_ID, { reason: 'x' })).rejects.toBeInstanceOf(NotFoundException);
    });

    it('unsuspends back to APPROVED and clears the suspension reason', async () => {
      prisma.business.findFirst.mockResolvedValue(
        business({ status: BusinessStatus.SUSPENDED, rejectionReason: 'Spam' }),
      );
      prisma.business.findUniqueOrThrow.mockResolvedValue(business({ status: BusinessStatus.APPROVED }));

      const result = await service.unsuspendBusiness(5, ADMIN_ID);

      expect(result.status).toBe(BusinessStatus.APPROVED);
      expect(prisma.business.updateMany).toHaveBeenCalledWith({
        where: { id: 5, status: BusinessStatus.SUSPENDED, deletedAt: null },
        data: { status: BusinessStatus.APPROVED, rejectionReason: null },
      });
      expect(prisma.auditLog.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ action: AuditAction.RESTORE, entityId: 5 }),
      });
    });

    it.each([BusinessStatus.APPROVED, BusinessStatus.PENDING, BusinessStatus.HIDDEN, BusinessStatus.REJECTED])(
      'refuses to unsuspend a %s business (409) — cannot be used to approve or unhide',
      async (status) => {
        prisma.business.findFirst.mockResolvedValue(business({ status }));
        await expect(service.unsuspendBusiness(5, ADMIN_ID)).rejects.toBeInstanceOf(ConflictException);
        expect(prisma.business.updateMany).not.toHaveBeenCalled();
      },
    );

    it('404s unsuspending a nonexistent business', async () => {
      prisma.business.findFirst.mockResolvedValue(null);
      await expect(service.unsuspendBusiness(404, ADMIN_ID)).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  // --------------------------------------------------------------------------
  describe('promoteBusiness / unpromoteBusiness', () => {
    const future = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

    it('promotes until a future date', async () => {
      prisma.business.findFirst.mockResolvedValue(business());

      const result = await service.promoteBusiness(5, ADMIN_ID, { until: future });

      expect(result.isPromoted).toBe(true);
      expect(prisma.business.update).toHaveBeenCalledWith({
        where: { id: 5 },
        data: { isPromoted: true, promotedUntil: new Date(future) },
      });
    });

    it('rejects a past promotion end date (400) without touching the database', async () => {
      await expect(
        service.promoteBusiness(5, ADMIN_ID, { until: '2000-01-01T00:00:00.000Z' }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.business.findFirst).not.toHaveBeenCalled();
    });

    it('404s promoting a nonexistent business', async () => {
      prisma.business.findFirst.mockResolvedValue(null);
      await expect(service.promoteBusiness(404, ADMIN_ID, { until: future })).rejects.toBeInstanceOf(NotFoundException);
    });

    it('ends a promotion early, clearing the flag and end date', async () => {
      prisma.business.findFirst.mockResolvedValue(business({ isPromoted: true, promotedUntil: new Date(future) }));

      const result = await service.unpromoteBusiness(5, ADMIN_ID);

      expect(result.isPromoted).toBe(false);
      expect(prisma.business.update).toHaveBeenCalledWith({
        where: { id: 5 },
        data: { isPromoted: false, promotedUntil: null },
      });
      expect(prisma.auditLog.create).toHaveBeenCalled();
    });

    it('allows cleaning up a promotion whose end date already passed', async () => {
      prisma.business.findFirst.mockResolvedValue(
        business({ isPromoted: true, promotedUntil: new Date('2000-01-01T00:00:00.000Z') }),
      );
      await expect(service.unpromoteBusiness(5, ADMIN_ID)).resolves.toMatchObject({ isPromoted: false });
    });

    it('refuses to unpromote a business that is not promoted (409)', async () => {
      prisma.business.findFirst.mockResolvedValue(business({ isPromoted: false }));
      await expect(service.unpromoteBusiness(5, ADMIN_ID)).rejects.toBeInstanceOf(ConflictException);
      expect(prisma.business.update).not.toHaveBeenCalled();
    });

    it('404s unpromoting a nonexistent business', async () => {
      prisma.business.findFirst.mockResolvedValue(null);
      await expect(service.unpromoteBusiness(404, ADMIN_ID)).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  // --------------------------------------------------------------------------
  describe('resolveReport', () => {
    const pendingReport = {
      id: 3,
      status: ReportStatus.PENDING,
      review: { id: 11, branchId: 2, status: ReviewStatus.PUBLISHED, moderationNote: null },
    };

    it('records DISMISS as DISMISSED and leaves the review alone', async () => {
      prisma.reviewReport.findUnique.mockResolvedValue(pendingReport);

      const result = await service.resolveReport(3, ADMIN_ID, { action: ReportResolveAction.DISMISS });

      expect(result.status).toBe(ReportStatus.DISMISSED);
      expect(prisma.reviewReport.update).toHaveBeenCalledWith({
        where: { id: 3 },
        data: expect.objectContaining({ status: ReportStatus.DISMISSED, resolvedById: ADMIN_ID }),
      });
      expect(prisma.review.update).not.toHaveBeenCalled();
      expect(reviewsService.recalculateAggregates).not.toHaveBeenCalled();
    });

    it('records HIDE_REVIEW as RESOLVED, hides the review and recalculates aggregates', async () => {
      prisma.reviewReport.findUnique.mockResolvedValue(pendingReport);

      const result = await service.resolveReport(3, ADMIN_ID, { action: ReportResolveAction.HIDE_REVIEW, note: 'Spam' });

      expect(result.status).toBe(ReportStatus.RESOLVED);
      expect(prisma.review.update).toHaveBeenCalledWith({
        where: { id: 11 },
        data: { status: ReviewStatus.HIDDEN, moderationNote: 'Spam' },
      });
      expect(reviewsService.recalculateAggregates).toHaveBeenCalledWith(2, prisma);
    });

    it('refuses to resolve a report twice (409)', async () => {
      prisma.reviewReport.findUnique.mockResolvedValue({ ...pendingReport, status: ReportStatus.DISMISSED });
      await expect(
        service.resolveReport(3, ADMIN_ID, { action: ReportResolveAction.DISMISS }),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('404s resolving a nonexistent report', async () => {
      prisma.reviewReport.findUnique.mockResolvedValue(null);
      await expect(
        service.resolveReport(404, ADMIN_ID, { action: ReportResolveAction.DISMISS }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });
});
