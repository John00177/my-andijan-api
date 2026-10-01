import { ConflictException, NotFoundException } from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { Test } from '@nestjs/testing';
import { BusinessStatus, Prisma, ReportReason, ReviewStatus } from '@prisma/client';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { ReviewsService } from './reviews.service';
import { ReviewsController } from './reviews.controller';
import { CreateReviewReportDto } from './dto/create-review-report.dto';
import { PrismaService } from '../prisma/prisma.service';
import { HealthScoreService } from '../health-score/health-score.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { ROLES_KEY } from '../common/decorators/roles.decorator';

describe('Review reporting (POST /reviews/:id/report)', () => {
  let service: ReviewsService;
  let prisma: {
    $transaction: jest.Mock;
    review: { findFirst: jest.Mock; update: jest.Mock };
    reviewReport: { create: jest.Mock };
  };

  beforeEach(async () => {
    prisma = {
      $transaction: jest.fn((fn: (tx: unknown) => unknown) => fn(prisma)),
      review: { findFirst: jest.fn(), update: jest.fn() },
      reviewReport: {
        create: jest.fn(({ data }) =>
          Promise.resolve({ id: 1, reviewId: data.reviewId, reason: data.reason, status: 'PENDING', createdAt: new Date() }),
        ),
      },
    };

    const moduleRef = await Test.createTestingModule({
      providers: [
        ReviewsService,
        { provide: PrismaService, useValue: prisma },
        { provide: HealthScoreService, useValue: {} },
      ],
    }).compile();
    service = moduleRef.get(ReviewsService);
  });

  describe('service', () => {
    it('creates a PENDING report and increments the review reportCount in one transaction', async () => {
      prisma.review.findFirst.mockResolvedValue({ id: 11 });

      const result = await service.report(11, 7, { reason: ReportReason.SPAM, note: 'Reklama' });

      expect(result).toMatchObject({ reviewId: 11, reason: ReportReason.SPAM, status: 'PENDING' });
      expect(prisma.reviewReport.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: { reviewId: 11, reporterId: 7, reason: ReportReason.SPAM, note: 'Reklama' } }),
      );
      expect(prisma.review.update).toHaveBeenCalledWith({ where: { id: 11 }, data: { reportCount: { increment: 1 } } });
      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    });

    it('never exposes the reporter in the response', async () => {
      prisma.review.findFirst.mockResolvedValue({ id: 11 });
      await service.report(11, 7, { reason: ReportReason.FAKE });

      const { select } = prisma.reviewReport.create.mock.calls[0][0];
      expect(select).not.toHaveProperty('reporterId');
      expect(select).not.toHaveProperty('reporter');
    });

    it('only accepts reviews the public can see (published, live branch, approved business)', async () => {
      prisma.review.findFirst.mockResolvedValue({ id: 11 });
      await service.report(11, 7, { reason: ReportReason.OFFENSIVE });

      expect(prisma.review.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            id: 11,
            deletedAt: null,
            status: ReviewStatus.PUBLISHED,
            branch: { deletedAt: null, business: { status: BusinessStatus.APPROVED, deletedAt: null } },
          },
        }),
      );
    });

    it('404s for a nonexistent, hidden, deleted or unpublished-business review — without writing anything', async () => {
      prisma.review.findFirst.mockResolvedValue(null);

      await expect(service.report(404, 7, { reason: ReportReason.SPAM })).rejects.toBeInstanceOf(NotFoundException);
      expect(prisma.reviewReport.create).not.toHaveBeenCalled();
      expect(prisma.review.update).not.toHaveBeenCalled();
    });

    it('409s when the same user reports the same review twice (@@unique reviewId+reporterId)', async () => {
      prisma.review.findFirst.mockResolvedValue({ id: 11 });
      prisma.reviewReport.create.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('Unique constraint failed', { code: 'P2002', clientVersion: '5.22.0' }),
      );

      await expect(service.report(11, 7, { reason: ReportReason.SPAM })).rejects.toBeInstanceOf(ConflictException);
      expect(prisma.review.update).not.toHaveBeenCalled();
    });

    it('rethrows unexpected database errors', async () => {
      prisma.review.findFirst.mockResolvedValue({ id: 11 });
      prisma.reviewReport.create.mockRejectedValue(new Error('connection lost'));

      await expect(service.report(11, 7, { reason: ReportReason.SPAM })).rejects.toThrow('connection lost');
    });
  });

  describe('DTO validation', () => {
    async function errorsFor(body: unknown) {
      return validate(plainToInstance(CreateReviewReportDto, body));
    }

    it.each(Object.values(ReportReason))('accepts reason %s', async (reason) => {
      expect(await errorsFor({ reason })).toHaveLength(0);
    });

    it('rejects a missing or unknown reason', async () => {
      expect(await errorsFor({})).not.toHaveLength(0);
      expect(await errorsFor({ reason: 'BORING' })).not.toHaveLength(0);
    });

    it('rejects a note longer than 1000 characters', async () => {
      expect(await errorsFor({ reason: ReportReason.OTHER, note: 'x'.repeat(1001) })).not.toHaveLength(0);
      expect(await errorsFor({ reason: ReportReason.OTHER, note: 'x'.repeat(1000) })).toHaveLength(0);
    });
  });

  describe('route authorization', () => {
    it('requires an authenticated user (JwtAuthGuard) — anonymous requests get 401', () => {
      expect(Reflect.getMetadata(GUARDS_METADATA, ReviewsController.prototype.report)).toEqual([JwtAuthGuard]);
    });

    it('has no role floor — any signed-in role may report, like writing a review', () => {
      expect(Reflect.getMetadata(ROLES_KEY, ReviewsController.prototype.report)).toBeUndefined();
      expect(Reflect.getMetadata(ROLES_KEY, ReviewsController)).toBeUndefined();
    });
  });
});
