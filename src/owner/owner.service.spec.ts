import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { BusinessStatus, ClaimStatus } from '@prisma/client';
import { OwnerService } from './owner.service';
import { PrismaService } from '../prisma/prisma.service';
import { ReviewsService } from '../reviews/reviews.service';
import { EventsService } from '../events/events.service';
import { HealthScoreService } from '../health-score/health-score.service';

describe('OwnerService.createClaim', () => {
  let service: OwnerService;
  let prisma: {
    business: { findFirst: jest.Mock };
    businessClaim: { findFirst: jest.Mock; create: jest.Mock };
  };

  const claimant = { id: 7, phone: '+998901234567', role: 'CUSTOMER' as const };
  const dto = { businessId: 5 };

  beforeEach(async () => {
    prisma = {
      business: { findFirst: jest.fn() },
      businessClaim: { findFirst: jest.fn(), create: jest.fn() },
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

  it('rejects a claim against a nonexistent business', async () => {
    prisma.business.findFirst.mockResolvedValue(null);

    await expect(service.createClaim(claimant, dto)).rejects.toThrow(NotFoundException);
    expect(prisma.businessClaim.create).not.toHaveBeenCalled();
  });

  it('rejects a claim against a business that is not yet APPROVED', async () => {
    prisma.business.findFirst.mockResolvedValue({ id: 5, status: BusinessStatus.PENDING, ownerId: null });

    await expect(service.createClaim(claimant, dto)).rejects.toThrow(BadRequestException);
    expect(prisma.businessClaim.create).not.toHaveBeenCalled();
  });

  it('rejects a claim against a business that is already owned', async () => {
    prisma.business.findFirst.mockResolvedValue({ id: 5, status: BusinessStatus.APPROVED, ownerId: 99 });

    await expect(service.createClaim(claimant, dto)).rejects.toThrow(ConflictException);
    expect(prisma.businessClaim.create).not.toHaveBeenCalled();
  });

  it('rejects a duplicate pending claim from the same user for the same business', async () => {
    prisma.business.findFirst.mockResolvedValue({ id: 5, status: BusinessStatus.APPROVED, ownerId: null });
    prisma.businessClaim.findFirst.mockResolvedValue({ id: 2, status: ClaimStatus.PENDING });

    await expect(service.createClaim(claimant, dto)).rejects.toThrow(ConflictException);
    expect(prisma.businessClaim.create).not.toHaveBeenCalled();
  });
});
