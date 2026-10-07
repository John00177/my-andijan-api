import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AuditAction, BusinessStatus, ClaimStatus, Prisma } from '@prisma/client';
import { OwnerService } from './owner.service';
import { PrismaService } from '../prisma/prisma.service';
import { ReviewsService } from '../reviews/reviews.service';
import { EventsService } from '../events/events.service';
import { HealthScoreService } from '../health-score/health-score.service';

describe('OwnerService.createClaim', () => {
  let service: OwnerService;
  let prisma: {
    $transaction: jest.Mock;
    $queryRaw: jest.Mock;
    business: { findFirst: jest.Mock };
    businessClaim: { findFirst: jest.Mock; create: jest.Mock };
    auditLog: { create: jest.Mock };
  };

  const claimant = { id: 7, phone: '+998901234567', role: 'CUSTOMER' as const };
  const dto = { businessId: 5 };

  beforeEach(async () => {
    prisma = {
      // createClaim writes the claim and its audit row in one callback-form
      // transaction; run the callback against the same mock.
      $transaction: jest.fn((fn: (tx: unknown) => unknown) => fn(prisma)),
      // The locked "still claimable?" re-check (Phase 16H): claimable by default.
      $queryRaw: jest.fn().mockResolvedValue([{ id: 5 }]),
      business: { findFirst: jest.fn() },
      businessClaim: { findFirst: jest.fn(), create: jest.fn() },
      auditLog: { create: jest.fn() },
    };

    const moduleRef = await Test.createTestingModule({
      providers: [
        OwnerService,
        { provide: PrismaService, useValue: prisma },
        { provide: ReviewsService, useValue: {} },
        { provide: EventsService, useValue: {} },
        { provide: HealthScoreService, useValue: {} },
      ],
    }).compile();

    service = moduleRef.get(OwnerService);
  });

  it('creates a pending claim for an approved, unowned business', async () => {
    prisma.business.findFirst.mockResolvedValue({ id: 5, status: BusinessStatus.APPROVED, ownerId: null });
    prisma.businessClaim.findFirst.mockResolvedValue(null);
    prisma.businessClaim.create.mockResolvedValue({ id: 1, businessId: 5, claimantId: 7, status: ClaimStatus.PENDING });

    const result = await service.createClaim(claimant, dto);

    expect(result).toEqual({ id: 1, businessId: 5, claimantId: 7, status: ClaimStatus.PENDING });
    expect(prisma.businessClaim.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ businessId: 5, claimantId: 7 }) }),
    );
  });

  it('writes a CREATE audit row for the claim, in the same transaction, without copying evidence or contact details', async () => {
    prisma.business.findFirst.mockResolvedValue({ id: 5, status: BusinessStatus.APPROVED, ownerId: null });
    prisma.businessClaim.findFirst.mockResolvedValue(null);
    prisma.businessClaim.create.mockResolvedValue({ id: 1, businessId: 5, claimantId: 7, status: ClaimStatus.PENDING });

    await service.createClaim(claimant, {
      businessId: 5,
      evidence: 'I am the registered owner',
      contactPhone: '+998901112233',
      contactNote: 'Call after 18:00',
    });

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(prisma.auditLog.create).toHaveBeenCalledTimes(1);
    const { data } = prisma.auditLog.create.mock.calls[0][0];
    expect(data).toEqual(
      expect.objectContaining({
        actorId: 7,
        action: AuditAction.CREATE,
        entityType: 'BusinessClaim',
        entityId: 1,
        before: {},
        after: { businessId: 5, status: ClaimStatus.PENDING },
      }),
    );
    const serialized = JSON.stringify(data);
    for (const sensitive of ['I am the registered owner', '+998901112233', 'Call after 18:00']) {
      expect(serialized).not.toContain(sensitive);
    }
  });

  it('rejects a claim against a nonexistent business', async () => {
    prisma.business.findFirst.mockResolvedValue(null);

    await expect(service.createClaim(claimant, dto)).rejects.toThrow(NotFoundException);
    expect(prisma.businessClaim.create).not.toHaveBeenCalled();
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });

  it('rejects a claim against a business that is not yet APPROVED', async () => {
    prisma.business.findFirst.mockResolvedValue({ id: 5, status: BusinessStatus.PENDING, ownerId: null });

    await expect(service.createClaim(claimant, dto)).rejects.toThrow(BadRequestException);
    expect(prisma.businessClaim.create).not.toHaveBeenCalled();
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });

  it('rejects a claim against a business that is already owned', async () => {
    prisma.business.findFirst.mockResolvedValue({ id: 5, status: BusinessStatus.APPROVED, ownerId: 99 });

    await expect(service.createClaim(claimant, dto)).rejects.toThrow(ConflictException);
    expect(prisma.businessClaim.create).not.toHaveBeenCalled();
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });

  it('rejects a duplicate pending claim from the same user for the same business', async () => {
    prisma.business.findFirst.mockResolvedValue({ id: 5, status: BusinessStatus.APPROVED, ownerId: null });
    prisma.businessClaim.findFirst.mockResolvedValue({ id: 2, status: ClaimStatus.PENDING });

    await expect(service.createClaim(claimant, dto)).rejects.toThrow(ConflictException);
    expect(prisma.businessClaim.create).not.toHaveBeenCalled();
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });

  // ---- Phase 16H: concurrency backstops (real-database proof: test/db/claims-concurrency.db-spec.ts)

  it('re-checks the business under a FOR SHARE row lock, inside the transaction, before inserting', async () => {
    prisma.business.findFirst.mockResolvedValue({ id: 5, status: BusinessStatus.APPROVED, ownerId: null });
    prisma.businessClaim.findFirst.mockResolvedValue(null);
    prisma.businessClaim.create.mockResolvedValue({ id: 1, businessId: 5, claimantId: 7, status: ClaimStatus.PENDING });

    await service.createClaim(claimant, dto);

    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
    const [strings, ...values] = prisma.$queryRaw.mock.calls[0];
    const sql = (strings as string[]).join('?');
    expect(sql).toMatch(/owner_id IS NULL/);
    expect(sql).toMatch(/status = 'APPROVED'/);
    expect(sql).toMatch(/deleted_at IS NULL/);
    expect(sql).toMatch(/FOR SHARE\s*$/);
    expect(values).toEqual([5]);
    expect(prisma.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
      prisma.businessClaim.create.mock.invocationCallOrder[0],
    );
  });

  it('refuses with 409 when the business was claimed (or stopped being claimable) after the pre-checks', async () => {
    prisma.business.findFirst.mockResolvedValue({ id: 5, status: BusinessStatus.APPROVED, ownerId: null });
    prisma.businessClaim.findFirst.mockResolvedValue(null);
    prisma.$queryRaw.mockResolvedValue([]); // a concurrent approval committed first

    await expect(service.createClaim(claimant, dto)).rejects.toThrow(
      new ConflictException('This business is already claimed or no longer open to claims'),
    );
    expect(prisma.businessClaim.create).not.toHaveBeenCalled();
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });

  it('reports a duplicate refused by the pending-claim unique index (P2002) as the same 409, not a 500', async () => {
    prisma.business.findFirst.mockResolvedValue({ id: 5, status: BusinessStatus.APPROVED, ownerId: null });
    prisma.businessClaim.findFirst.mockResolvedValue(null); // the concurrent twin was not committed yet
    prisma.businessClaim.create.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('Unique constraint failed', { code: 'P2002', clientVersion: 'test' }),
    );

    await expect(service.createClaim(claimant, dto)).rejects.toThrow(
      new ConflictException('You already have a pending claim for this business'),
    );
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });

  it('does not mask other database errors as a duplicate', async () => {
    prisma.business.findFirst.mockResolvedValue({ id: 5, status: BusinessStatus.APPROVED, ownerId: null });
    prisma.businessClaim.findFirst.mockResolvedValue(null);
    const fkError = new Prisma.PrismaClientKnownRequestError('Foreign key failed', {
      code: 'P2003',
      clientVersion: 'test',
    });
    prisma.businessClaim.create.mockRejectedValue(fkError);

    await expect(service.createClaim(claimant, dto)).rejects.toBe(fkError);
  });
});
