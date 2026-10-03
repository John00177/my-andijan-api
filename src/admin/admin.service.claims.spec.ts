import { ConflictException, NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AuditAction, ClaimStatus, UserRole } from '@prisma/client';
import { AdminService } from './admin.service';
import { PrismaService } from '../prisma/prisma.service';
import { ReviewsService } from '../reviews/reviews.service';

describe('AdminService — claims', () => {
  let service: AdminService;
  let prisma: {
    $transaction: jest.Mock;
    businessClaim: {
      findMany: jest.Mock;
      count: jest.Mock;
      findUnique: jest.Mock;
      findUniqueOrThrow: jest.Mock;
      updateMany: jest.Mock;
    };
    business: { updateMany: jest.Mock };
    user: { findUniqueOrThrow: jest.Mock; update: jest.Mock };
    auditLog: { create: jest.Mock };
  };

  const pendingClaim = { id: 1, businessId: 5, claimantId: 7, status: ClaimStatus.PENDING };

  beforeEach(async () => {
    prisma = {
      $transaction: jest.fn((arg: unknown) => {
        // approveClaim/rejectClaim use the callback form; findClaims uses the
        // array form — support both the way AdminService actually calls them.
        if (typeof arg === 'function') return (arg as (tx: unknown) => unknown)(prisma);
        return Promise.all(arg as Promise<unknown>[]);
      }),
      businessClaim: {
        findMany: jest.fn().mockResolvedValue([]),
        count: jest.fn(),
        findUnique: jest.fn(),
        findUniqueOrThrow: jest.fn(),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      business: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      user: { findUniqueOrThrow: jest.fn(), update: jest.fn() },
      auditLog: { create: jest.fn() },
    };

    const moduleRef = await Test.createTestingModule({
      providers: [
        AdminService,
        { provide: PrismaService, useValue: prisma },
        { provide: ReviewsService, useValue: {} },
      ],
    }).compile();

    service = moduleRef.get(AdminService);
  });

  describe('findClaims', () => {
    it('paginates claims with no status filter by default', async () => {
      const rows = [{ id: 1, status: ClaimStatus.PENDING }];
      prisma.businessClaim.findMany.mockResolvedValue(rows);
      prisma.businessClaim.count.mockResolvedValue(1);

      const result = await service.findClaims({ page: 1, limit: 20 } as any);

      expect(result).toEqual({ data: rows, meta: { page: 1, limit: 20, total: 1, totalPages: 1 } });
      expect(prisma.businessClaim.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: {} }));
    });

    it('filters by status when provided', async () => {
      prisma.businessClaim.findMany.mockResolvedValue([]);
      prisma.businessClaim.count.mockResolvedValue(0);

      await service.findClaims({ status: ClaimStatus.APPROVED, page: 1, limit: 20 } as any);

      const call = prisma.businessClaim.findMany.mock.calls[0][0];
      expect(call.where).toEqual({ status: ClaimStatus.APPROVED });
    });

    // Phase 16E.1: the queue carries the state a reviewer needs before acting
    // — listing status/deletion, competing pending claims, claimant status.
    it('includes the review context: business status, deletion, pending-claim count and claimant status', async () => {
      prisma.businessClaim.findMany.mockResolvedValue([]);
      prisma.businessClaim.count.mockResolvedValue(0);

      await service.findClaims({ page: 1, limit: 20 } as any);

      const { include } = prisma.businessClaim.findMany.mock.calls[0][0];
      expect(include.business.select).toEqual(
        expect.objectContaining({
          status: true,
          deletedAt: true,
          ownerId: true,
          _count: { select: { claims: { where: { status: ClaimStatus.PENDING } } } },
        }),
      );
      expect(include.claimant.select).toEqual(expect.objectContaining({ status: true }));
    });

    it('selects claimant fields explicitly — never credentials or session state', async () => {
      prisma.businessClaim.findMany.mockResolvedValue([]);
      prisma.businessClaim.count.mockResolvedValue(0);

      await service.findClaims({ page: 1, limit: 20 } as any);

      const { include } = prisma.businessClaim.findMany.mock.calls[0][0];
      expect(Object.keys(include.claimant.select).sort()).toEqual(
        ['email', 'fullName', 'id', 'phone', 'role', 'status'].sort(),
      );
    });
  });

  describe('approveClaim', () => {
    beforeEach(() => {
      prisma.businessClaim.findUnique.mockResolvedValue(pendingClaim);
      prisma.businessClaim.findUniqueOrThrow.mockResolvedValue({ ...pendingClaim, status: ClaimStatus.APPROVED });
    });

    it('assigns ownership only if the business is still unowned, approves, promotes, and audits', async () => {
      prisma.user.findUniqueOrThrow.mockResolvedValue({ id: 7, role: UserRole.CUSTOMER });

      const result = await service.approveClaim(1, 99);

      expect(result.status).toBe(ClaimStatus.APPROVED);
      expect(prisma.business.updateMany).toHaveBeenCalledWith({
        where: { id: 5, ownerId: null },
        data: { ownerId: 7 },
      });
      expect(prisma.businessClaim.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 1, status: ClaimStatus.PENDING },
          data: expect.objectContaining({ status: ClaimStatus.APPROVED, reviewedById: 99 }),
        }),
      );
      expect(prisma.user.update).toHaveBeenCalledWith({ where: { id: 7 }, data: { role: UserRole.BUSINESS_OWNER } });
      for (const [action, entityType] of [
        [AuditAction.UPDATE, 'Business'],
        [AuditAction.APPROVE, 'BusinessClaim'],
        [AuditAction.ROLE_CHANGE, 'User'],
      ]) {
        expect(prisma.auditLog.create).toHaveBeenCalledWith(
          expect.objectContaining({ data: expect.objectContaining({ action, entityType }) }),
        );
      }
    });

    it('does not change the role of a claimant who is already above CUSTOMER', async () => {
      prisma.user.findUniqueOrThrow.mockResolvedValue({ id: 7, role: UserRole.BUSINESS_OWNER });

      await service.approveClaim(1, 99);

      expect(prisma.user.update).not.toHaveBeenCalled();
    });

    it('refuses with 409 and never approves the claim when the business already has an owner (lost ownership race)', async () => {
      prisma.business.updateMany.mockResolvedValue({ count: 0 });

      await expect(service.approveClaim(1, 99)).rejects.toThrow(ConflictException);

      // Ownership is checked first, so the claim is never transitioned and
      // nobody is promoted — and in a real DB the throw rolls back the tx.
      expect(prisma.businessClaim.updateMany).not.toHaveBeenCalled();
      expect(prisma.user.update).not.toHaveBeenCalled();
      expect(prisma.auditLog.create).not.toHaveBeenCalled();
    });

    it('refuses with 409 when a concurrent reviewer already moved the claim out of PENDING', async () => {
      prisma.businessClaim.updateMany.mockResolvedValue({ count: 0 });

      await expect(service.approveClaim(1, 99)).rejects.toThrow(ConflictException);
      expect(prisma.user.update).not.toHaveBeenCalled();
    });

    it('rejects every other still-pending claim on the same business once one is approved', async () => {
      prisma.user.findUniqueOrThrow.mockResolvedValue({ id: 7, role: UserRole.BUSINESS_OWNER });
      prisma.businessClaim.findMany.mockResolvedValue([{ id: 2 }, { id: 3 }]);

      await service.approveClaim(1, 99);

      for (const otherId of [2, 3]) {
        expect(prisma.businessClaim.updateMany).toHaveBeenCalledWith(
          expect.objectContaining({
            where: { id: otherId, status: ClaimStatus.PENDING },
            data: expect.objectContaining({ status: ClaimStatus.REJECTED }),
          }),
        );
      }
    });

    it('refuses to approve a nonexistent claim', async () => {
      prisma.businessClaim.findUnique.mockResolvedValue(null);

      await expect(service.approveClaim(1, 99)).rejects.toThrow(NotFoundException);
      expect(prisma.business.updateMany).not.toHaveBeenCalled();
    });

    it('refuses to re-approve an already-reviewed claim', async () => {
      prisma.businessClaim.findUnique.mockResolvedValue({ ...pendingClaim, status: ClaimStatus.APPROVED });

      await expect(service.approveClaim(1, 99)).rejects.toThrow(ConflictException);
      expect(prisma.business.updateMany).not.toHaveBeenCalled();
    });
  });

  describe('rejectClaim', () => {
    it('marks a pending claim rejected with a reason, without touching ownership or roles', async () => {
      prisma.businessClaim.findUnique.mockResolvedValue(pendingClaim);
      prisma.businessClaim.findUniqueOrThrow.mockResolvedValue({
        ...pendingClaim,
        status: ClaimStatus.REJECTED,
        rejectionReason: 'Not a verified representative',
      });

      const result = await service.rejectClaim(1, 99, { reason: 'Not a verified representative' });

      expect(result.status).toBe(ClaimStatus.REJECTED);
      expect(prisma.businessClaim.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 1, status: ClaimStatus.PENDING } }),
      );
      expect(prisma.business.updateMany).not.toHaveBeenCalled();
      expect(prisma.user.update).not.toHaveBeenCalled();
      expect(prisma.auditLog.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ action: AuditAction.REJECT, entityType: 'BusinessClaim' }) }),
      );
    });

    it('refuses with 409 when a concurrent approval already moved the claim out of PENDING', async () => {
      prisma.businessClaim.findUnique.mockResolvedValue(pendingClaim);
      prisma.businessClaim.updateMany.mockResolvedValue({ count: 0 });

      await expect(service.rejectClaim(1, 99, { reason: 'x' })).rejects.toThrow(ConflictException);
      expect(prisma.auditLog.create).not.toHaveBeenCalled();
    });

    it('refuses to reject an already-reviewed claim', async () => {
      prisma.businessClaim.findUnique.mockResolvedValue({ id: 1, status: ClaimStatus.REJECTED });

      await expect(service.rejectClaim(1, 99, { reason: 'x' })).rejects.toThrow(ConflictException);
    });
  });
});
