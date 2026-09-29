import { Test } from '@nestjs/testing';
import { ReviewStatus } from '@prisma/client';
import { AdminService } from './admin.service';
import { PrismaService } from '../prisma/prisma.service';
import { ReviewsService } from '../reviews/reviews.service';

describe('AdminService.findReviews', () => {
  let service: AdminService;
  let prisma: {
    $transaction: jest.Mock;
    review: { findMany: jest.Mock; count: jest.Mock };
  };

  beforeEach(async () => {
    prisma = {
      $transaction: jest.fn((ops: Promise<unknown>[]) => Promise.all(ops)),
      review: { findMany: jest.fn(), count: jest.fn() },
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

  it('paginates non-deleted reviews with no status filter by default', async () => {
    const rows = [{ id: 1, rating: 5, comment: 'Zo\'r joy', status: ReviewStatus.PUBLISHED }];
    prisma.review.findMany.mockResolvedValue(rows);
    prisma.review.count.mockResolvedValue(1);

    const result = await service.findReviews({ page: 1, limit: 20 } as any);

    expect(result).toEqual({ data: rows, meta: { page: 1, limit: 20, total: 1, totalPages: 1 } });
    expect(prisma.review.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { deletedAt: null } }),
    );
  });

  it('filters by status when provided', async () => {
    prisma.review.findMany.mockResolvedValue([]);
    prisma.review.count.mockResolvedValue(0);

    await service.findReviews({ status: ReviewStatus.HIDDEN, page: 1, limit: 20 } as any);

    const call = prisma.review.findMany.mock.calls[0][0];
    expect(call.where).toEqual({ deletedAt: null, status: ReviewStatus.HIDDEN });
  });

  it('applies pagination (skip/take) from page and limit', async () => {
    prisma.review.findMany.mockResolvedValue([]);
    prisma.review.count.mockResolvedValue(45);

    const result = await service.findReviews({ page: 2, limit: 10 } as any);

    const call = prisma.review.findMany.mock.calls[0][0];
    expect(call.skip).toBe(10);
    expect(call.take).toBe(10);
    expect(result.meta).toEqual({ page: 2, limit: 10, total: 45, totalPages: 5 });
  });

  it('includes reviewer, business, and reply info for moderation', async () => {
    prisma.review.findMany.mockResolvedValue([]);
    prisma.review.count.mockResolvedValue(0);

    await service.findReviews({ page: 1, limit: 20 } as any);

    const call = prisma.review.findMany.mock.calls[0][0];
    expect(call.include.user).toEqual({ select: { id: true, fullName: true, avatarUrl: true } });
    expect(call.include.branch.select.business).toEqual({
      select: { id: true, slug: true, name: true },
    });
    expect(call.include.reply).toBeDefined();
  });
});
