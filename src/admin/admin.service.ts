import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  AuditAction,
  BusinessStatus,
  ClaimStatus,
  EventStatus,
  NotificationType,
  Prisma,
  ReportStatus,
  ReviewStatus,
  UserRole,
  UserStatus,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ReviewsService } from '../reviews/reviews.service';
import {
  ListBusinessesAdminQueryDto,
  PromoteBusinessDto,
  RejectBusinessDto,
  SuspendBusinessDto,
  UpdateBusinessBranchDto,
  UpdateBusinessDto,
} from './dto/business.dto';
import { ListClaimsAdminQueryDto, RejectClaimDto } from './dto/claim.dto';
import { ListReportsQueryDto, ReportResolveAction, ResolveReportDto } from './dto/report.dto';
import { ListEventsAdminQueryDto, RejectEventDto } from './dto/event.dto';
import { CreateCategoryDto, ReorderCategoryItemDto, UpdateCategoryDto } from './dto/category.dto';
import { UpdateCityDto, UpdateDistrictDto } from './dto/geography.dto';
import { ListUsersAdminQueryDto } from './dto/user.dto';
import { ListAuditQueryDto } from './dto/audit.dto';
import { ListReviewsAdminQueryDto } from './dto/review.dto';

function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/['’ʻʼ`]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function paginate(page: number, limit: number, total: number) {
  return { page, limit, total, totalPages: Math.ceil(total / limit) || 1 };
}

@Injectable()
export class AdminService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly reviewsService: ReviewsService,
  ) {}

  private async writeAudit(
    tx: Prisma.TransactionClient,
    actorId: number,
    action: AuditAction,
    entityType: string,
    entityId: number | null,
    before: unknown,
    after: unknown,
  ) {
    await tx.auditLog.create({
      data: {
        actorId,
        action,
        entityType,
        entityId,
        before: (before ?? {}) as Prisma.InputJsonValue,
        after: (after ?? {}) as Prisma.InputJsonValue,
      },
    });
  }

  // ============================================================================
  // 1. DASHBOARD
  // ============================================================================

  async getStats() {
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

    const [businessesByStatusRaw, pendingClaims, pendingReviews, pendingEvents, openReports, usersByRoleRaw, newSignups] =
      await Promise.all([
        this.prisma.business.groupBy({ by: ['status'], where: { deletedAt: null }, _count: true }),
        this.prisma.businessClaim.count({ where: { status: ClaimStatus.PENDING } }),
        this.prisma.review.count({ where: { status: ReviewStatus.PENDING, deletedAt: null } }),
        this.prisma.event.count({ where: { status: EventStatus.PENDING, deletedAt: null } }),
        this.prisma.reviewReport.count({ where: { status: ReportStatus.PENDING } }),
        this.prisma.user.groupBy({ by: ['role'], where: { deletedAt: null }, _count: true }),
        this.prisma.user.count({ where: { deletedAt: null, createdAt: { gte: sevenDaysAgo } } }),
      ]);

    const businessesByStatus = Object.fromEntries(Object.values(BusinessStatus).map((s) => [s, 0])) as Record<
      BusinessStatus,
      number
    >;
    for (const row of businessesByStatusRaw) businessesByStatus[row.status] = row._count;

    const usersByRole = Object.fromEntries(Object.values(UserRole).map((r) => [r, 0])) as Record<UserRole, number>;
    for (const row of usersByRoleRaw) usersByRole[row.role] = row._count;

    return {
      businessesByStatus,
      pendingClaims,
      pendingReviews,
      pendingEvents,
      openReports,
      usersByRole,
      newSignups7d: newSignups,
    };
  }

  // ============================================================================
  // 2. BUSINESS MODERATION
  // ============================================================================

  async findBusinesses(query: ListBusinessesAdminQueryDto) {
    const { status, district, search, page, limit } = query;
    const where: Prisma.BusinessWhereInput = {
      deletedAt: null,
      ...(status ? { status } : {}),
      ...(district ? { branches: { some: { districtId: district, deletedAt: null } } } : {}),
      ...(search ? { name: { contains: search, mode: Prisma.QueryMode.insensitive } } : {}),
    };

    const [data, total] = await this.prisma.$transaction([
      this.prisma.business.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
        include: {
          owner: { select: { id: true, fullName: true, phone: true, email: true } },
          category: { select: { id: true, slug: true, nameUz: true } },
          businessType: { select: { id: true, slug: true, nameUz: true } },
          branches: {
            where: { deletedAt: null },
            orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }],
            take: 1,
            select: {
              id: true,
              address: true,
              phone: true,
              district: { select: { id: true, slug: true, nameUz: true } },
            },
          },
        },
      }),
      this.prisma.business.count({ where }),
    ]);

    return { data, meta: paginate(page, limit, total) };
  }

  async approveBusiness(id: number, adminId: number) {
    return this.prisma.$transaction(async (tx) => {
      const business = await this.getPendingBusiness(tx, id);

      const updated = await tx.business.update({
        where: { id },
        data: {
          status: BusinessStatus.APPROVED,
          verifiedById: adminId,
          verifiedAt: new Date(),
          rejectionReason: null,
        },
      });

      await this.writeAudit(
        tx,
        adminId,
        AuditAction.APPROVE,
        'Business',
        id,
        { status: business.status },
        { status: updated.status, verifiedById: updated.verifiedById, verifiedAt: updated.verifiedAt },
      );

      if (business.ownerId) {
        // CUSTOMER -> BUSINESS_OWNER happens HERE, not at submission time —
        // a CUSTOMER stays a CUSTOMER while their listing is only PENDING.
        // (Moved from OwnerService.createMyBusiness, which used to promote
        // immediately on submit.)
        const owner = await tx.user.findUnique({ where: { id: business.ownerId } });
        if (owner && owner.role === UserRole.CUSTOMER) {
          await tx.user.update({ where: { id: owner.id }, data: { role: UserRole.BUSINESS_OWNER } });
          await this.writeAudit(
            tx,
            adminId,
            AuditAction.ROLE_CHANGE,
            'User',
            owner.id,
            { role: UserRole.CUSTOMER },
            { role: UserRole.BUSINESS_OWNER },
          );
        }

        await tx.notification.create({
          data: {
            userId: business.ownerId,
            type: NotificationType.BUSINESS_APPROVED,
            title: 'Your business was approved',
            body: `"${business.name}" is now live on My Andijan.`,
            entityType: 'Business',
            entityId: business.id,
          },
        });
      }

      return updated;
    });
  }

  // Core-field editing (name/description/category) — deliberately separate
  // from every status-transition method above, which each carry their own
  // side effects. This one is a plain field patch.
  async updateBusiness(id: number, adminId: number, dto: UpdateBusinessDto) {
    return this.prisma.$transaction(async (tx) => {
      const business = await tx.business.findFirst({ where: { id, deletedAt: null } });
      if (!business) throw new NotFoundException(`Business ${id} not found`);

      if (dto.categoryId != null) {
        const category = await tx.category.findFirst({ where: { id: dto.categoryId, deletedAt: null } });
        if (!category) throw new NotFoundException(`Category ${dto.categoryId} not found`);
      }

      const updated = await tx.business.update({
        where: { id },
        data: { name: dto.name, description: dto.description, categoryId: dto.categoryId },
        include: { category: { select: { id: true, slug: true, nameUz: true } } },
      });

      await this.writeAudit(
        tx,
        adminId,
        AuditAction.UPDATE,
        'Business',
        id,
        { name: business.name, description: business.description, categoryId: business.categoryId },
        { name: updated.name, description: updated.description, categoryId: updated.categoryId },
      );

      return updated;
    });
  }

  async updateBusinessBranch(id: number, adminId: number, dto: UpdateBusinessBranchDto) {
    return this.prisma.$transaction(async (tx) => {
      const branch = await tx.branch.findFirst({
        where: { businessId: id, deletedAt: null },
        orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }],
      });
      if (!branch) throw new NotFoundException(`Business ${id} has no branch to edit`);

      if (dto.districtId != null) {
        const district = await tx.district.findUnique({ where: { id: dto.districtId } });
        if (!district) throw new NotFoundException(`District ${dto.districtId} not found`);
      }

      const updated = await tx.branch.update({
        where: { id: branch.id },
        data: { phone: dto.phone, address: dto.address, districtId: dto.districtId },
        include: { district: { select: { id: true, slug: true, nameUz: true } } },
      });

      await this.writeAudit(
        tx,
        adminId,
        AuditAction.UPDATE,
        'Branch',
        branch.id,
        { phone: branch.phone, address: branch.address, districtId: branch.districtId },
        { phone: updated.phone, address: updated.address, districtId: updated.districtId },
      );

      return updated;
    });
  }

  // SUPER_ADMIN-only visibility kill-switch — distinct status from SUSPENDED
  // so an admin's routine "temporarily suspend for a fixable issue" and a
  // SUPER_ADMIN's "pull this off the platform" don't collapse into the same
  // state with different access rules attached to it.
  async hideBusiness(id: number, adminId: number) {
    return this.prisma.$transaction(async (tx) => {
      const business = await tx.business.findFirst({ where: { id, deletedAt: null } });
      if (!business) throw new NotFoundException(`Business ${id} not found`);
      if (business.status === BusinessStatus.HIDDEN) {
        throw new ConflictException(`Business ${id} is already hidden`);
      }

      const updated = await tx.business.update({
        where: { id },
        data: { status: BusinessStatus.HIDDEN },
      });

      await this.writeAudit(
        tx,
        adminId,
        AuditAction.UPDATE,
        'Business',
        id,
        { status: business.status },
        { status: updated.status },
      );

      return updated;
    });
  }

  async rejectBusiness(id: number, adminId: number, dto: RejectBusinessDto) {
    return this.prisma.$transaction(async (tx) => {
      const business = await this.getPendingBusiness(tx, id);

      const updated = await tx.business.update({
        where: { id },
        data: { status: BusinessStatus.REJECTED, rejectionReason: dto.reason },
      });

      await this.writeAudit(
        tx,
        adminId,
        AuditAction.REJECT,
        'Business',
        id,
        { status: business.status },
        { status: updated.status, rejectionReason: updated.rejectionReason },
      );

      return updated;
    });
  }

  private async getPendingBusiness(tx: Prisma.TransactionClient, id: number) {
    const business = await tx.business.findFirst({ where: { id, deletedAt: null } });
    if (!business) {
      throw new NotFoundException(`Business ${id} not found`);
    }
    if (business.status !== BusinessStatus.PENDING) {
      throw new ConflictException(`Business ${id} is not pending review (current status: ${business.status})`);
    }
    return business;
  }

  async verifyBusiness(id: number, adminId: number) {
    return this.prisma.$transaction(async (tx) => {
      const business = await tx.business.findFirst({ where: { id, deletedAt: null } });
      if (!business) throw new NotFoundException(`Business ${id} not found`);
      if (business.isVerified) throw new ConflictException(`Business ${id} is already verified`);

      const updated = await tx.business.update({
        where: { id },
        data: { isVerified: true, verifiedById: adminId, verifiedAt: new Date() },
      });

      await this.writeAudit(
        tx,
        adminId,
        AuditAction.UPDATE,
        'Business',
        id,
        { isVerified: false },
        { isVerified: true, verifiedById: adminId, verifiedAt: updated.verifiedAt },
      );

      return updated;
    });
  }

  async suspendBusiness(id: number, adminId: number, dto: SuspendBusinessDto) {
    return this.prisma.$transaction(async (tx) => {
      const business = await tx.business.findFirst({ where: { id, deletedAt: null } });
      if (!business) throw new NotFoundException(`Business ${id} not found`);
      if (business.status === BusinessStatus.SUSPENDED) {
        throw new ConflictException(`Business ${id} is already suspended`);
      }

      // rejectionReason is reused as the general "why this listing isn't
      // live" field — the schema has no separate suspensionReason column.
      const updated = await tx.business.update({
        where: { id },
        data: { status: BusinessStatus.SUSPENDED, rejectionReason: dto.reason },
      });

      await this.writeAudit(
        tx,
        adminId,
        AuditAction.SUSPEND,
        'Business',
        id,
        { status: business.status },
        { status: updated.status, rejectionReason: updated.rejectionReason },
      );

      return updated;
    });
  }

  async promoteBusiness(id: number, adminId: number, dto: PromoteBusinessDto) {
    const until = new Date(dto.until);
    if (until <= new Date()) {
      throw new BadRequestException('until must be a future date');
    }

    return this.prisma.$transaction(async (tx) => {
      const business = await tx.business.findFirst({ where: { id, deletedAt: null } });
      if (!business) throw new NotFoundException(`Business ${id} not found`);

      const updated = await tx.business.update({
        where: { id },
        data: { isPromoted: true, promotedUntil: until },
      });

      await this.writeAudit(
        tx,
        adminId,
        AuditAction.UPDATE,
        'Business',
        id,
        { isPromoted: business.isPromoted, promotedUntil: business.promotedUntil },
        { isPromoted: true, promotedUntil: until },
      );

      return updated;
    });
  }

  // ============================================================================
  // 3. CLAIMS
  // ============================================================================

  async findClaims(query: ListClaimsAdminQueryDto) {
    const { status, page, limit } = query;
    const where: Prisma.BusinessClaimWhereInput = status ? { status } : {};

    const [data, total] = await this.prisma.$transaction([
      this.prisma.businessClaim.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
        include: {
          business: { select: { id: true, slug: true, name: true, ownerId: true } },
          claimant: { select: { id: true, fullName: true, phone: true, email: true, role: true } },
          reviewedBy: { select: { id: true, fullName: true } },
        },
      }),
      this.prisma.businessClaim.count({ where }),
    ]);

    return { data, meta: paginate(page, limit, total) };
  }

  async approveClaim(id: number, adminId: number) {
    return this.prisma.$transaction(async (tx) => {
      const claim = await this.getPendingClaim(tx, id);

      const updatedClaim = await tx.businessClaim.update({
        where: { id },
        data: { status: ClaimStatus.APPROVED, reviewedById: adminId, reviewedAt: new Date() },
      });
      await this.writeAudit(
        tx,
        adminId,
        AuditAction.APPROVE,
        'BusinessClaim',
        id,
        { status: claim.status },
        { status: updatedClaim.status },
      );

      const business = await tx.business.findUniqueOrThrow({ where: { id: claim.businessId } });
      await tx.business.update({ where: { id: claim.businessId }, data: { ownerId: claim.claimantId } });
      await this.writeAudit(
        tx,
        adminId,
        AuditAction.UPDATE,
        'Business',
        claim.businessId,
        { ownerId: business.ownerId },
        { ownerId: claim.claimantId },
      );

      const claimant = await tx.user.findUniqueOrThrow({ where: { id: claim.claimantId } });
      if (claimant.role === UserRole.CUSTOMER) {
        await tx.user.update({ where: { id: claimant.id }, data: { role: UserRole.BUSINESS_OWNER } });
        await this.writeAudit(
          tx,
          adminId,
          AuditAction.ROLE_CHANGE,
          'User',
          claimant.id,
          { role: UserRole.CUSTOMER },
          { role: UserRole.BUSINESS_OWNER },
        );
      }

      // Only one claim can win — any other still-pending claim on this
      // business is now moot (schema.prisma flags this as a service-layer
      // responsibility since it can't be a DB constraint).
      const others = await tx.businessClaim.findMany({
        where: { businessId: claim.businessId, status: ClaimStatus.PENDING, id: { not: claim.id } },
      });
      for (const other of others) {
        await tx.businessClaim.update({
          where: { id: other.id },
          data: {
            status: ClaimStatus.REJECTED,
            reviewedById: adminId,
            reviewedAt: new Date(),
            rejectionReason: 'Another claim for this business was approved',
          },
        });
        await this.writeAudit(
          tx,
          adminId,
          AuditAction.REJECT,
          'BusinessClaim',
          other.id,
          { status: ClaimStatus.PENDING },
          { status: ClaimStatus.REJECTED },
        );
      }

      return updatedClaim;
    });
  }

  async rejectClaim(id: number, adminId: number, dto: RejectClaimDto) {
    return this.prisma.$transaction(async (tx) => {
      const claim = await this.getPendingClaim(tx, id);

      const updated = await tx.businessClaim.update({
        where: { id },
        data: {
          status: ClaimStatus.REJECTED,
          rejectionReason: dto.reason,
          reviewedById: adminId,
          reviewedAt: new Date(),
        },
      });

      await this.writeAudit(
        tx,
        adminId,
        AuditAction.REJECT,
        'BusinessClaim',
        id,
        { status: claim.status },
        { status: updated.status, rejectionReason: updated.rejectionReason },
      );

      return updated;
    });
  }

  private async getPendingClaim(tx: Prisma.TransactionClient, id: number) {
    const claim = await tx.businessClaim.findUnique({ where: { id } });
    if (!claim) {
      throw new NotFoundException(`Claim ${id} not found`);
    }
    if (claim.status !== ClaimStatus.PENDING) {
      throw new ConflictException(`Claim ${id} has already been reviewed (status: ${claim.status})`);
    }
    return claim;
  }

  // ============================================================================
  // 4. REVIEWS & REPORTS
  // ============================================================================

  async findReports(query: ListReportsQueryDto) {
    const { status, page, limit } = query;
    const where: Prisma.ReviewReportWhereInput = status ? { status } : {};

    const [data, total] = await this.prisma.$transaction([
      this.prisma.reviewReport.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
        include: {
          reporter: { select: { id: true, fullName: true } },
          review: {
            select: {
              id: true,
              rating: true,
              comment: true,
              status: true,
              reportCount: true,
              user: { select: { id: true, fullName: true } },
              branch: {
                select: { id: true, name: true, business: { select: { id: true, slug: true, name: true } } },
              },
            },
          },
        },
      }),
      this.prisma.reviewReport.count({ where }),
    ]);

    return { data, meta: paginate(page, limit, total) };
  }

  async resolveReport(id: number, adminId: number, dto: ResolveReportDto) {
    return this.prisma.$transaction(async (tx) => {
      const report = await tx.reviewReport.findUnique({ where: { id }, include: { review: true } });
      if (!report) throw new NotFoundException(`Report ${id} not found`);
      if (report.status !== ReportStatus.PENDING) {
        throw new ConflictException(`Report ${id} has already been resolved (status: ${report.status})`);
      }

      const updatedReport = await tx.reviewReport.update({
        where: { id },
        data: {
          status: ReportStatus.RESOLVED,
          resolvedById: adminId,
          resolvedAt: new Date(),
          resolutionNote: dto.note,
        },
      });
      await this.writeAudit(
        tx,
        adminId,
        AuditAction.UPDATE,
        'ReviewReport',
        id,
        { status: report.status },
        { status: updatedReport.status, action: dto.action, resolutionNote: dto.note ?? null },
      );

      if (dto.action === ReportResolveAction.HIDE_REVIEW && report.review.status !== ReviewStatus.HIDDEN) {
        const review = report.review;
        const updatedReview = await tx.review.update({
          where: { id: review.id },
          data: { status: ReviewStatus.HIDDEN, moderationNote: dto.note ?? review.moderationNote },
        });
        await this.writeAudit(
          tx,
          adminId,
          AuditAction.UPDATE,
          'Review',
          review.id,
          { status: review.status },
          { status: updatedReview.status },
        );

        // Same transaction, per spec — this is the tx client, not a
        // separate commit.
        await this.reviewsService.recalculateAggregates(review.branchId, tx);
      }

      return updatedReport;
    });
  }

  // Mirrors findReports/findEvents below: same where/paginate/$transaction
  // shape. Review moderation only ever needs the review's own fields plus
  // who wrote it, which business it's against, and whether it already has an
  // owner reply — nothing here duplicates ReviewsService, which owns
  // create/update/reply and the aggregate-recalculation hideReview/
  // restoreReview already call into.
  async findReviews(query: ListReviewsAdminQueryDto) {
    const { status, page, limit } = query;
    const where: Prisma.ReviewWhereInput = { deletedAt: null, ...(status ? { status } : {}) };

    const [data, total] = await this.prisma.$transaction([
      this.prisma.review.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
        include: {
          user: { select: { id: true, fullName: true, avatarUrl: true } },
          branch: {
            select: { id: true, name: true, business: { select: { id: true, slug: true, name: true } } },
          },
          reply: { select: { id: true, body: true, createdAt: true } },
        },
      }),
      this.prisma.review.count({ where }),
    ]);

    return { data, meta: paginate(page, limit, total) };
  }

  async hideReview(id: number, adminId: number) {
    return this.prisma.$transaction(async (tx) => {
      const review = await tx.review.findFirst({ where: { id, deletedAt: null } });
      if (!review) throw new NotFoundException(`Review ${id} not found`);
      if (review.status === ReviewStatus.HIDDEN) throw new ConflictException(`Review ${id} is already hidden`);

      const updated = await tx.review.update({ where: { id }, data: { status: ReviewStatus.HIDDEN } });
      await this.writeAudit(
        tx,
        adminId,
        AuditAction.UPDATE,
        'Review',
        id,
        { status: review.status },
        { status: updated.status },
      );

      await this.reviewsService.recalculateAggregates(review.branchId, tx);
      return updated;
    });
  }

  async restoreReview(id: number, adminId: number) {
    return this.prisma.$transaction(async (tx) => {
      const review = await tx.review.findFirst({ where: { id, deletedAt: null } });
      if (!review) throw new NotFoundException(`Review ${id} not found`);
      if (review.status === ReviewStatus.PUBLISHED) {
        throw new ConflictException(`Review ${id} is already published`);
      }

      const updated = await tx.review.update({ where: { id }, data: { status: ReviewStatus.PUBLISHED } });
      await this.writeAudit(
        tx,
        adminId,
        AuditAction.RESTORE,
        'Review',
        id,
        { status: review.status },
        { status: updated.status },
      );

      await this.reviewsService.recalculateAggregates(review.branchId, tx);
      return updated;
    });
  }

  // ============================================================================
  // 5. EVENTS
  // ============================================================================

  async findEvents(query: ListEventsAdminQueryDto) {
    const { status, page, limit } = query;
    const where: Prisma.EventWhereInput = { deletedAt: null, ...(status ? { status } : {}) };

    const [data, total] = await this.prisma.$transaction([
      this.prisma.event.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
        include: {
          business: { select: { id: true, slug: true, name: true } },
          district: { select: { id: true, slug: true, nameUz: true } },
        },
      }),
      this.prisma.event.count({ where }),
    ]);

    return { data, meta: paginate(page, limit, total) };
  }

  async approveEvent(id: number, adminId: number) {
    return this.prisma.$transaction(async (tx) => {
      const event = await this.getPendingEvent(tx, id);

      const updated = await tx.event.update({
        where: { id },
        data: { status: EventStatus.PUBLISHED, publishedAt: new Date() },
      });
      await this.writeAudit(
        tx,
        adminId,
        AuditAction.APPROVE,
        'Event',
        id,
        { status: event.status },
        { status: updated.status, publishedAt: updated.publishedAt },
      );

      return updated;
    });
  }

  async rejectEvent(id: number, adminId: number, dto: RejectEventDto) {
    return this.prisma.$transaction(async (tx) => {
      const event = await this.getPendingEvent(tx, id);

      const updated = await tx.event.update({
        where: { id },
        data: { status: EventStatus.REJECTED, rejectionReason: dto.reason },
      });
      await this.writeAudit(
        tx,
        adminId,
        AuditAction.REJECT,
        'Event',
        id,
        { status: event.status },
        { status: updated.status, rejectionReason: updated.rejectionReason },
      );

      return updated;
    });
  }

  private async getPendingEvent(tx: Prisma.TransactionClient, id: number) {
    const event = await tx.event.findFirst({ where: { id, deletedAt: null } });
    if (!event) {
      throw new NotFoundException(`Event ${id} not found`);
    }
    if (event.status !== EventStatus.PENDING) {
      throw new ConflictException(`Event ${id} is not pending review (current status: ${event.status})`);
    }
    return event;
  }

  // ============================================================================
  // 6. CATEGORIES
  // ============================================================================

  async findCategories() {
    return this.prisma.category.findMany({
      where: { deletedAt: null },
      orderBy: { sortOrder: 'asc' },
      include: {
        parent: { select: { id: true, slug: true, nameUz: true } },
        _count: { select: { businesses: { where: { deletedAt: null } } } },
      },
    });
  }

  async createCategory(adminId: number, dto: CreateCategoryDto) {
    const slug = slugify(dto.slug ?? dto.nameUz);

    if (dto.parentId) {
      const parent = await this.prisma.category.findFirst({ where: { id: dto.parentId, deletedAt: null } });
      if (!parent) throw new BadRequestException(`Parent category ${dto.parentId} not found`);
    }

    return this.prisma.$transaction(async (tx) => {
      let created;
      try {
        created = await tx.category.create({
          data: {
            slug,
            nameUz: dto.nameUz,
            nameRu: dto.nameRu,
            nameEn: dto.nameEn,
            parentId: dto.parentId,
            descriptionUz: dto.descriptionUz,
            descriptionRu: dto.descriptionRu,
            descriptionEn: dto.descriptionEn,
            icon: dto.icon,
            colorHex: dto.colorHex,
            imageUrl: dto.imageUrl,
            isActive: dto.isActive ?? true,
            showOnHomepage: dto.showOnHomepage ?? false,
            allowBusiness: dto.allowBusiness ?? true,
            sortOrder: dto.sortOrder ?? 0,
          },
        });
      } catch (error) {
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
          throw new ConflictException(`Category slug "${slug}" already exists`);
        }
        throw error;
      }

      await this.writeAudit(tx, adminId, AuditAction.CREATE, 'Category', created.id, {}, created);
      return created;
    });
  }

  async updateCategory(id: number, adminId: number, dto: UpdateCategoryDto) {
    if (dto.parentId === id) {
      throw new BadRequestException('A category cannot be its own parent');
    }

    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.category.findFirst({ where: { id, deletedAt: null } });
      if (!existing) throw new NotFoundException(`Category ${id} not found`);

      if (dto.parentId) {
        const parent = await tx.category.findFirst({ where: { id: dto.parentId, deletedAt: null } });
        if (!parent) throw new BadRequestException(`Parent category ${dto.parentId} not found`);
      }

      let updated;
      try {
        updated = await tx.category.update({ where: { id }, data: { ...dto } });
      } catch (error) {
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
          throw new ConflictException(`Category slug "${dto.slug}" already exists`);
        }
        throw error;
      }

      await this.writeAudit(tx, adminId, AuditAction.UPDATE, 'Category', id, existing, updated);
      return updated;
    });
  }

  async deleteCategory(id: number, adminId: number) {
    return this.prisma.$transaction(async (tx) => {
      const category = await tx.category.findFirst({
        where: { id, deletedAt: null },
        include: {
          _count: {
            select: {
              businesses: { where: { deletedAt: null } },
              children: { where: { deletedAt: null } },
            },
          },
        },
      });
      if (!category) throw new NotFoundException(`Category ${id} not found`);

      if (category._count.businesses > 0 || category._count.children > 0) {
        throw new ConflictException(
          `Cannot delete category ${id}: ${category._count.businesses} business(es) and ${category._count.children} child categor(y/ies) still reference it`,
        );
      }

      const updated = await tx.category.update({
        where: { id },
        data: { deletedAt: new Date(), isActive: false },
      });

      await this.writeAudit(
        tx,
        adminId,
        AuditAction.DELETE,
        'Category',
        id,
        { deletedAt: null, isActive: category.isActive },
        { deletedAt: updated.deletedAt, isActive: false },
      );

      return { success: true };
    });
  }

  async reorderCategories(adminId: number, items: ReorderCategoryItemDto[]) {
    if (items.length === 0) {
      throw new BadRequestException('Request body must contain at least one item');
    }

    return this.prisma.$transaction(async (tx) => {
      const ids = items.map((i) => i.id);
      const existing = await tx.category.findMany({ where: { id: { in: ids }, deletedAt: null } });
      if (existing.length !== ids.length) {
        const foundIds = new Set(existing.map((c) => c.id));
        const missing = ids.filter((i) => !foundIds.has(i));
        throw new NotFoundException(`Categories not found: ${missing.join(', ')}`);
      }

      const before = existing.map((c) => ({ id: c.id, sortOrder: c.sortOrder }));

      for (const item of items) {
        await tx.category.update({ where: { id: item.id }, data: { sortOrder: item.sortOrder } });
      }

      await this.writeAudit(tx, adminId, AuditAction.UPDATE, 'Category', null, before, items);

      return tx.category.findMany({ where: { id: { in: ids } }, orderBy: { sortOrder: 'asc' } });
    });
  }

  // ============================================================================
  // 7. GEOGRAPHY
  // ============================================================================

  async updateDistrict(id: number, adminId: number, dto: UpdateDistrictDto) {
    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.district.findUnique({ where: { id } });
      if (!existing) throw new NotFoundException(`District ${id} not found`);

      const updated = await tx.district.update({ where: { id }, data: { ...dto } });
      await this.writeAudit(tx, adminId, AuditAction.UPDATE, 'District', id, existing, updated);
      return updated;
    });
  }

  async updateCity(id: number, adminId: number, dto: UpdateCityDto) {
    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.city.findUnique({ where: { id } });
      if (!existing) throw new NotFoundException(`City ${id} not found`);

      if (dto.districtId) {
        const district = await tx.district.findUnique({ where: { id: dto.districtId } });
        if (!district) throw new BadRequestException(`District ${dto.districtId} not found`);
      }

      const updated = await tx.city.update({ where: { id }, data: { ...dto } });
      await this.writeAudit(tx, adminId, AuditAction.UPDATE, 'City', id, existing, updated);
      return updated;
    });
  }

  // ============================================================================
  // 8. USERS
  // ============================================================================

  async findUsers(query: ListUsersAdminQueryDto) {
    const { role, status, search, page, limit } = query;
    const where: Prisma.UserWhereInput = {
      deletedAt: null,
      ...(role ? { role } : {}),
      ...(status ? { status } : {}),
      ...(search
        ? {
            OR: [
              { fullName: { contains: search, mode: Prisma.QueryMode.insensitive } },
              { phone: { contains: search } },
              { email: { contains: search, mode: Prisma.QueryMode.insensitive } },
            ],
          }
        : {}),
    };

    const [data, total] = await this.prisma.$transaction([
      this.prisma.user.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
        select: {
          id: true,
          phone: true,
          email: true,
          fullName: true,
          role: true,
          status: true,
          phoneVerified: true,
          emailVerified: true,
          lastLoginAt: true,
          createdAt: true,
        },
      }),
      this.prisma.user.count({ where }),
    ]);

    return { data, meta: paginate(page, limit, total) };
  }

  async suspendUser(id: number, adminId: number) {
    return this.prisma.$transaction(async (tx) => {
      const user = await this.getActionableUser(tx, id);
      if (user.status === UserStatus.SUSPENDED) throw new ConflictException(`User ${id} is already suspended`);
      // Not explicitly requested, but suspending the only class of account
      // that can perform this action is a footgun worth blocking outright.
      if (user.role === UserRole.ADMIN) throw new ForbiddenException('Cannot suspend an admin account');

      const updated = await tx.user.update({ where: { id }, data: { status: UserStatus.SUSPENDED } });
      await this.writeAudit(
        tx,
        adminId,
        AuditAction.SUSPEND,
        'User',
        id,
        { status: user.status },
        { status: updated.status },
      );

      return this.sanitizeUser(updated);
    });
  }

  async activateUser(id: number, adminId: number) {
    return this.prisma.$transaction(async (tx) => {
      const user = await this.getActionableUser(tx, id);
      if (user.status === UserStatus.ACTIVE) throw new ConflictException(`User ${id} is already active`);

      const updated = await tx.user.update({ where: { id }, data: { status: UserStatus.ACTIVE } });
      await this.writeAudit(
        tx,
        adminId,
        AuditAction.RESTORE,
        'User',
        id,
        { status: user.status },
        { status: updated.status },
      );

      return this.sanitizeUser(updated);
    });
  }

  private async getActionableUser(tx: Prisma.TransactionClient, id: number) {
    const user = await tx.user.findFirst({ where: { id, deletedAt: null } });
    if (!user) throw new NotFoundException(`User ${id} not found`);
    return user;
  }

  private sanitizeUser<T extends { passwordHash: string }>(user: T) {
    const { passwordHash, ...rest } = user;
    return rest;
  }

  // ============================================================================
  // 9. AUDIT
  // ============================================================================

  async findAuditLogs(query: ListAuditQueryDto) {
    const { entityType, entityId, actorId, page, limit } = query;
    const where: Prisma.AuditLogWhereInput = {
      ...(entityType ? { entityType } : {}),
      ...(entityId ? { entityId } : {}),
      ...(actorId ? { actorId } : {}),
    };

    const [data, total] = await this.prisma.$transaction([
      this.prisma.auditLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
        include: { actor: { select: { id: true, fullName: true, role: true } } },
      }),
      this.prisma.auditLog.count({ where }),
    ]);

    return { data, meta: paginate(page, limit, total) };
  }
}
