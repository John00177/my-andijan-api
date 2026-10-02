import { ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { BusinessStatus, Prisma, ReviewStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { HealthScoreService } from '../health-score/health-score.service';
import { assertOwnsBusiness } from '../authz/policies';
import { AuthenticatedUser } from '../auth/strategies/jwt.strategy';
import { CreateReviewDto } from './dto/create-review.dto';
import { CreateBusinessReviewDto } from './dto/create-business-review.dto';
import { UpdateReviewDto } from './dto/update-review.dto';
import { CreateReplyDto } from './dto/create-reply.dto';
import { CreateReviewReportDto } from './dto/create-review-report.dto';

const REVIEW_INCLUDE = {
  user: { select: { id: true, fullName: true, avatarUrl: true } },
  reply: { include: { author: { select: { id: true, fullName: true } } } },
} satisfies Prisma.ReviewInclude;

@Injectable()
export class ReviewsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly healthScoreService: HealthScoreService,
  ) {}

  async create(userId: number, dto: CreateReviewDto) {
    const branch = await this.prisma.branch.findFirst({
      where: { id: dto.branchId, deletedAt: null, isActive: true },
    });
    if (!branch) {
      throw new NotFoundException(`Branch ${dto.branchId} not found`);
    }

    try {
      const review = await this.prisma.review.create({
        data: {
          branchId: dto.branchId,
          userId,
          rating: dto.rating,
          title: dto.title,
          comment: dto.comment,
          photos: dto.photos ?? [],
        },
        include: REVIEW_INCLUDE,
      });

      await this.recalculateAggregates(dto.branchId);
      return review;
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new ConflictException('You have already reviewed this branch');
      }
      throw error;
    }
  }

  // ============================================================================
  // BUSINESS-SCOPED CONVENIENCE (GET/POST /businesses/:id/reviews)
  //
  // Reviews are branch-scoped in storage (service quality is location-
  // specific — see the schema notes on Branch), but a business with one
  // branch is the common case and a caller shouldn't have to know a branch
  // id just to read or leave a review "for the business". GET flattens
  // across every branch (same query BusinessesService.findOne already runs
  // for the public detail page); POST targets the primary branch, the same
  // "business-level write resolves to primary branch" pattern PUT
  // /businesses/:id/hours uses for BranchHour.
  // ============================================================================

  async findForBusiness(businessId: number) {
    const business = await this.prisma.business.findFirst({ where: { id: businessId, deletedAt: null } });
    if (!business) {
      throw new NotFoundException(`Business ${businessId} not found`);
    }

    return this.prisma.review.findMany({
      where: { status: ReviewStatus.PUBLISHED, deletedAt: null, branch: { businessId } },
      orderBy: { createdAt: 'desc' },
      include: REVIEW_INCLUDE,
    });
  }

  async createForBusiness(userId: number, businessId: number, dto: CreateBusinessReviewDto) {
    const primaryBranch = await this.prisma.branch.findFirst({
      where: { businessId, deletedAt: null, isActive: true },
      orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }],
    });
    if (!primaryBranch) {
      throw new NotFoundException(`Business ${businessId} has no branch to review`);
    }

    return this.create(userId, { branchId: primaryBranch.id, ...dto });
  }

  async findOne(id: number) {
    const review = await this.prisma.review.findFirst({
      where: { id, status: ReviewStatus.PUBLISHED, deletedAt: null },
      include: REVIEW_INCLUDE,
    });
    if (!review) {
      throw new NotFoundException(`Review ${id} not found`);
    }
    return review;
  }

  async update(id: number, userId: number, dto: UpdateReviewDto) {
    const review = await this.getOwnedReview(id, userId);

    const updated = await this.prisma.review.update({
      where: { id },
      data: { ...dto },
      include: REVIEW_INCLUDE,
    });

    if (dto.rating !== undefined && dto.rating !== review.rating) {
      await this.recalculateAggregates(review.branchId);
    }

    return updated;
  }

  async remove(id: number, userId: number) {
    const review = await this.getOwnedReview(id, userId);

    await this.prisma.review.update({
      where: { id },
      data: { deletedAt: new Date() },
    });

    await this.recalculateAggregates(review.branchId);
    return { success: true };
  }

  // Customer-facing report — the producer for the existing admin moderation
  // queue (GET /admin/reports), which had no way to be filled before. Only a
  // review the reporter could actually see is reportable: PUBLISHED, not
  // deleted, on a non-deleted branch of an APPROVED business; anything else
  // 404s, matching public visibility. One report per user per review is the
  // schema's @@unique([reviewId, reporterId]) — a repeat is 409. reportCount
  // (shown in the admin queue) is incremented in the same transaction.
  async report(id: number, userId: number, dto: CreateReviewReportDto) {
    const review = await this.prisma.review.findFirst({
      where: {
        id,
        deletedAt: null,
        status: ReviewStatus.PUBLISHED,
        branch: { deletedAt: null, business: { status: BusinessStatus.APPROVED, deletedAt: null } },
      },
      select: { id: true },
    });
    if (!review) {
      throw new NotFoundException(`Review ${id} not found`);
    }

    try {
      return await this.prisma.$transaction(async (tx) => {
        const report = await tx.reviewReport.create({
          data: { reviewId: id, reporterId: userId, reason: dto.reason, note: dto.note },
          select: { id: true, reviewId: true, reason: true, status: true, createdAt: true },
        });
        await tx.review.update({ where: { id }, data: { reportCount: { increment: 1 } } });
        return report;
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new ConflictException('You have already reported this review');
      }
      throw error;
    }
  }

  async reply(id: number, user: AuthenticatedUser, dto: CreateReplyDto) {
    const review = await this.prisma.review.findFirst({
      where: { id, deletedAt: null },
      include: { branch: { include: { business: true } } },
    });
    if (!review) {
      throw new NotFoundException(`Review ${id} not found`);
    }

    // Owner only (Phase 15B, D-74). A reply is displayed as the business
    // speaking, so no staff role may author one on a business it doesn't own —
    // the old "rank >= MODERATOR" bypass let moderators answer as any business.
    assertOwnsBusiness(review.branch.business, user, 'Only the owner of this business can reply to this review');

    try {
      const created = await this.prisma.reviewReply.create({
        data: { reviewId: id, authorId: user.id, body: dto.body },
        include: { author: { select: { id: true, fullName: true } } },
      });

      // Replying changes reply rate and average response time but leaves
      // rating/count untouched, so it never reaches recalculateAggregates —
      // this is its own hook. Non-blocking: a scoring failure must not lose the
      // owner a reply they successfully posted.
      await this.healthScoreService.recalculateSafely(review.branch.businessId);

      return created;
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new ConflictException('This review already has a reply');
      }
      throw error;
    }
  }

  private async getOwnedReview(id: number, userId: number) {
    const review = await this.prisma.review.findFirst({ where: { id, deletedAt: null } });
    if (!review) {
      throw new NotFoundException(`Review ${id} not found`);
    }
    if (review.userId !== userId) {
      throw new ForbiddenException('You can only modify your own review');
    }
    return review;
  }

  // Branch and Business both carry denormalized rating/count columns so list
  // views never have to aggregate reviews live — every write here keeps both
  // in sync. Public: AdminService calls this too after moderation changes a
  // review's status.
  // Accepts an interactive-transaction client so callers (e.g. AdminService
  // hiding/restoring a review) can fold this into their own transaction
  // instead of committing separately. Defaults to the top-level client for
  // standalone use (ReviewsService's own create/update/delete paths).
  async recalculateAggregates(branchId: number, tx: Prisma.TransactionClient = this.prisma) {
    const branch = await tx.branch.findUniqueOrThrow({ where: { id: branchId } });

    const branchAgg = await tx.review.aggregate({
      where: { branchId, status: ReviewStatus.PUBLISHED, deletedAt: null },
      _avg: { rating: true },
      _count: true,
    });

    await tx.branch.update({
      where: { id: branchId },
      data: {
        ratingAvg: branchAgg._avg.rating ?? 0,
        reviewCount: branchAgg._count,
      },
    });

    const businessAgg = await tx.review.aggregate({
      where: { status: ReviewStatus.PUBLISHED, deletedAt: null, branch: { businessId: branch.businessId } },
      _avg: { rating: true },
      _count: true,
    });

    await tx.business.update({
      where: { id: branch.businessId },
      data: {
        ratingAvg: businessAgg._avg.rating ?? 0,
        reviewCount: businessAgg._count,
      },
    });

    // Health score hook. This method is the single choke point every review
    // mutation already funnels through — create, update, soft-delete here, plus
    // hide/restore/resolve-report in AdminService — so hooking it covers all of
    // them without touching six call sites. The caller's `tx` is passed
    // through, keeping the score inside their transaction (and their rollback).
    await this.healthScoreService.recalculate(branch.businessId, tx);
  }
}
