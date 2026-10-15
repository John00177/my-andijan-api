import { ConflictException, NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AuditAction, BusinessStatus } from '@prisma/client';
import { OwnerService } from './owner.service';
import { PrismaService } from '../prisma/prisma.service';
import { ReviewsService } from '../reviews/reviews.service';
import { EventsService } from '../events/events.service';
import { HealthScoreService } from '../health-score/health-score.service';

// Phase 16I: an owner sends a REJECTED listing back to moderation. The only
// owner-made status transition — REJECTED -> PENDING, nothing else.
describe('OwnerService.resubmitMyBusiness', () => {
  const OWNER_ID = 7;
  let service: OwnerService;
  let prisma: {
    $transaction: jest.Mock;
    business: { findFirst: jest.Mock; updateMany: jest.Mock; findUniqueOrThrow: jest.Mock };
    auditLog: { create: jest.Mock };
  };

  const listing = (overrides: Record<string, unknown> = {}) => ({
    id: 5,
    ownerId: OWNER_ID,
    name: 'Soy',
    status: BusinessStatus.REJECTED,
    rejectionReason: 'Telefon raqami noto‘g‘ri',
    deletedAt: null,
    ...overrides,
  });

  beforeEach(async () => {
    prisma = {
      $transaction: jest.fn((fn: (tx: unknown) => unknown) => fn(prisma)),
      business: {
        findFirst: jest.fn().mockResolvedValue(listing()),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        findUniqueOrThrow: jest.fn().mockResolvedValue(listing({ status: BusinessStatus.PENDING })),
      },
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

  it('moves the owner’s REJECTED listing to PENDING with a compare-and-set scoped to the owner', async () => {
    const result = await service.resubmitMyBusiness(OWNER_ID, 5);

    expect(prisma.business.findFirst).toHaveBeenCalledWith({ where: { id: 5, ownerId: OWNER_ID, deletedAt: null } });
    expect(prisma.business.updateMany).toHaveBeenCalledWith({
      where: { id: 5, ownerId: OWNER_ID, status: BusinessStatus.REJECTED, deletedAt: null },
      data: { status: BusinessStatus.PENDING },
    });
    expect(result.status).toBe(BusinessStatus.PENDING);
  });

  it('keeps rejectionReason for the moderator: the update writes status only', async () => {
    await service.resubmitMyBusiness(OWNER_ID, 5);

    const { data } = prisma.business.updateMany.mock.calls[0][0];
    expect(data).toEqual({ status: BusinessStatus.PENDING });
    expect(data).not.toHaveProperty('rejectionReason');
  });

  it('audits the resubmission in the same transaction, with the reason it answers', async () => {
    await service.resubmitMyBusiness(OWNER_ID, 5);

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(prisma.auditLog.create).toHaveBeenCalledTimes(1);
    const { data } = prisma.auditLog.create.mock.calls[0][0];
    expect(data).toMatchObject({
      actorId: OWNER_ID,
      action: AuditAction.UPDATE,
      entityType: 'Business',
      entityId: 5,
      before: { status: BusinessStatus.REJECTED, rejectionReason: 'Telefon raqami noto‘g‘ri' },
      after: { status: BusinessStatus.PENDING, resubmitted: true },
    });
  });

  it('answers 404 for a listing the caller does not own (or that does not exist) and writes nothing', async () => {
    prisma.business.findFirst.mockResolvedValue(null);

    await expect(service.resubmitMyBusiness(30, 5)).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.business.updateMany).not.toHaveBeenCalled();
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });

  it.each([
    BusinessStatus.DRAFT,
    BusinessStatus.PENDING,
    BusinessStatus.APPROVED,
    BusinessStatus.SUSPENDED,
    BusinessStatus.HIDDEN,
  ])('refuses a %s listing with 409 — only REJECTED can be resubmitted', async (status) => {
    prisma.business.findFirst.mockResolvedValue(listing({ status }));

    await expect(service.resubmitMyBusiness(OWNER_ID, 5)).rejects.toBeInstanceOf(ConflictException);
    expect(prisma.business.updateMany).not.toHaveBeenCalled();
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });

  it('answers 409 and writes no audit row when the status changed between the read and the update', async () => {
    prisma.business.updateMany.mockResolvedValue({ count: 0 });

    await expect(service.resubmitMyBusiness(OWNER_ID, 5)).rejects.toBeInstanceOf(ConflictException);
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });
});
