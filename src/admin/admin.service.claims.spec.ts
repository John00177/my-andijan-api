import { ConflictException, NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { AuditAction, BusinessStatus, ClaimStatus, UserRole, UserStatus } from '@prisma/client';
import { AdminService } from './admin.service';
import { ApproveClaimDto } from './dto/claim.dto';
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
    business: { findUnique: jest.Mock; updateMany: jest.Mock };
    user: { findUnique: jest.Mock; update: jest.Mock };
    auditLog: { create: jest.Mock };
  };

  const pendingClaim = { id: 1, businessId: 5, claimantId: 7, status: ClaimStatus.PENDING };
  const claimableBusiness = { id: 5, status: BusinessStatus.APPROVED, ownerId: null, deletedAt: null };
  const activeClaimant = { id: 7, role: UserRole.CUSTOMER, status: UserStatus.ACTIVE, deletedAt: null };
  const approveDto = { verificationNote: 'Called the phone already on the listing; owner confirmed' };

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
      business: { findUnique: jest.fn(), updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      user: { findUnique: jest.fn(), update: jest.fn() },
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
  });

  describe('approveClaim', () => {
    beforeEach(() => {
      prisma.businessClaim.findUnique.mockResolvedValue(pendingClaim);
      prisma.businessClaim.findUniqueOrThrow.mockResolvedValue({ ...pendingClaim, status: ClaimStatus.APPROVED });
      prisma.business.findUnique.mockResolvedValue(claimableBusiness);
      prisma.user.findUnique.mockResolvedValue(activeClaimant);
    });

    // Nothing may be written when an approval is refused: no ownership, no
    // claim transition, no promotion, no audit row.
    const expectNoWrites = () => {
      expect(prisma.business.updateMany).not.toHaveBeenCalled();
      expect(prisma.businessClaim.updateMany).not.toHaveBeenCalled();
      expect(prisma.user.update).not.toHaveBeenCalled();
      expect(prisma.auditLog.create).not.toHaveBeenCalled();
    };

    it('assigns ownership only if the business is still unowned and approved, approves, promotes, and audits', async () => {
      const result = await service.approveClaim(1, 99, approveDto);

      expect(result.status).toBe(ClaimStatus.APPROVED);
      expect(prisma.business.updateMany).toHaveBeenCalledWith({
        where: { id: 5, ownerId: null, status: BusinessStatus.APPROVED, deletedAt: null },
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

    it('records the verification note on the APPROVE audit row only', async () => {
      await service.approveClaim(1, 99, approveDto);

      expect(prisma.auditLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            action: AuditAction.APPROVE,
            entityType: 'BusinessClaim',
            entityId: 1,
            actorId: 99,
            note: approveDto.verificationNote,
          }),
        }),
      );
      const otherRows = prisma.auditLog.create.mock.calls
        .map(([arg]) => arg.data)
        .filter((data) => data.action !== AuditAction.APPROVE);
      expect(otherRows.length).toBeGreaterThan(0);
      for (const data of otherRows) expect(data.note).toBeNull();
    });

    it('does not change the role of a claimant who is already above CUSTOMER', async () => {
      prisma.user.findUnique.mockResolvedValue({ ...activeClaimant, role: UserRole.BUSINESS_OWNER });

      await service.approveClaim(1, 99, approveDto);

      expect(prisma.user.update).not.toHaveBeenCalled();
      expect(prisma.business.updateMany).toHaveBeenCalled();
    });

    it.each([BusinessStatus.PENDING, BusinessStatus.REJECTED, BusinessStatus.SUSPENDED, BusinessStatus.HIDDEN, BusinessStatus.DRAFT])(
      'refuses with 409 and writes nothing when the business is no longer APPROVED (%s)',
      async (status) => {
        prisma.business.findUnique.mockResolvedValue({ ...claimableBusiness, status });

        await expect(service.approveClaim(1, 99, approveDto)).rejects.toThrow(ConflictException);
        expectNoWrites();
      },
    );

    it('refuses with 409 and writes nothing when the business has been deleted', async () => {
      prisma.business.findUnique.mockResolvedValue({ ...claimableBusiness, deletedAt: new Date() });

      await expect(service.approveClaim(1, 99, approveDto)).rejects.toThrow(ConflictException);
      expectNoWrites();
    });

    it('refuses with 409 and writes nothing when the business row is gone', async () => {
      prisma.business.findUnique.mockResolvedValue(null);

      await expect(service.approveClaim(1, 99, approveDto)).rejects.toThrow(ConflictException);
      expectNoWrites();
    });

    it.each([UserStatus.SUSPENDED, UserStatus.DELETED])(
      'refuses with 409 and writes nothing when the claimant is %s',
      async (status) => {
        prisma.user.findUnique.mockResolvedValue({ ...activeClaimant, status });

        await expect(service.approveClaim(1, 99, approveDto)).rejects.toThrow(ConflictException);
        expectNoWrites();
      },
    );

    it('refuses with 409 and writes nothing when the claimant account is soft-deleted', async () => {
      prisma.user.findUnique.mockResolvedValue({ ...activeClaimant, deletedAt: new Date() });

      await expect(service.approveClaim(1, 99, approveDto)).rejects.toThrow(ConflictException);
      expectNoWrites();
    });

    it('refuses with 409 and writes nothing when the claimant row is gone', async () => {
      prisma.user.findUnique.mockResolvedValue(null);

      await expect(service.approveClaim(1, 99, approveDto)).rejects.toThrow(ConflictException);
      expectNoWrites();
    });

    it('refuses with 409 and never approves the claim when the ownership compare-and-set loses (owner assigned or status changed concurrently)', async () => {
      prisma.business.updateMany.mockResolvedValue({ count: 0 });

      await expect(service.approveClaim(1, 99, approveDto)).rejects.toThrow(ConflictException);

      // Ownership is checked first, so the claim is never transitioned and
      // nobody is promoted — and in a real DB the throw rolls back the tx.
      expect(prisma.businessClaim.updateMany).not.toHaveBeenCalled();
      expect(prisma.user.update).not.toHaveBeenCalled();
      expect(prisma.auditLog.create).not.toHaveBeenCalled();
    });

    it('refuses with 409 when a concurrent reviewer already moved the claim out of PENDING', async () => {
      prisma.businessClaim.updateMany.mockResolvedValue({ count: 0 });

      await expect(service.approveClaim(1, 99, approveDto)).rejects.toThrow(ConflictException);
      expect(prisma.user.update).not.toHaveBeenCalled();
    });

    it('rejects every other still-pending claim on the same business once one is approved', async () => {
      prisma.user.findUnique.mockResolvedValue({ ...activeClaimant, role: UserRole.BUSINESS_OWNER });
      prisma.businessClaim.findMany.mockResolvedValue([{ id: 2 }, { id: 3 }]);

      await service.approveClaim(1, 99, approveDto);

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

      await expect(service.approveClaim(1, 99, approveDto)).rejects.toThrow(NotFoundException);
      expect(prisma.business.updateMany).not.toHaveBeenCalled();
    });

    it('refuses to re-approve an already-reviewed claim', async () => {
      prisma.businessClaim.findUnique.mockResolvedValue({ ...pendingClaim, status: ClaimStatus.APPROVED });

      await expect(service.approveClaim(1, 99, approveDto)).rejects.toThrow(ConflictException);
      expect(prisma.business.updateMany).not.toHaveBeenCalled();
    });
  });

  describe('ApproveClaimDto', () => {
    const errorsFor = (body: object) => validate(plainToInstance(ApproveClaimDto, body));

    it('accepts a verification note', async () => {
      expect(await errorsFor(approveDto)).toHaveLength(0);
    });

    it.each([
      ['missing', {}],
      ['empty', { verificationNote: '' }],
      ['not a string', { verificationNote: 42 }],
      ['over 1000 characters', { verificationNote: 'x'.repeat(1001) }],
    ])('rejects a %s verification note', async (_name, body) => {
      const errors = await errorsFor(body);
      expect(errors.map((e) => e.property)).toEqual(['verificationNote']);
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
