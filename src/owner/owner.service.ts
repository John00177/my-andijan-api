import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { AuditAction, BusinessStatus, ClaimStatus, EventStatus, Prisma, ReviewStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { auditRequestFields } from '../common/request-context/request-context';
import { ReviewsService } from '../reviews/reviews.service';
import { EventsService } from '../events/events.service';
import { HealthScoreService } from '../health-score/health-score.service';
import { AuthenticatedUser } from '../auth/strategies/jwt.strategy';
import { CreateReplyDto } from '../reviews/dto/create-reply.dto';
import { CreateEventDto } from '../events/dto/create-event.dto';
import { CreateMyBusinessDto } from './dto/create-my-business.dto';
import { UpdateMyBusinessDto } from './dto/update-my-business.dto';
import { CreateBranchDto } from './dto/create-branch.dto';
import { UpdateBranchDto } from './dto/update-branch.dto';
import { UpdateMyEventDto } from './dto/update-my-event.dto';
import { PaginationQueryDto } from './dto/pagination.dto';
import { CreateClaimDto } from './dto/create-claim.dto';
import { slugBase } from '../common/slug';

const DUPLICATE_PENDING_CLAIM = 'You already have a pending claim for this business';

function paginate(page: number, limit: number, total: number) {
  return { page, limit, total, totalPages: Math.ceil(total / limit) || 1 };
}

@Injectable()
export class OwnerService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly reviewsService: ReviewsService,
    private readonly eventsService: EventsService,
    private readonly healthScoreService: HealthScoreService,
  ) {}

  // ============================================================================
  // STATS
  // ============================================================================

  async getStats(userId: number) {
    const [businessCount, reviewAgg, upcomingEvents, pendingClaims, healthAgg, openRecommendations] = await Promise.all([
      this.prisma.business.count({ where: { ownerId: userId, deletedAt: null } }),
      this.prisma.review.aggregate({
        where: { status: ReviewStatus.PUBLISHED, deletedAt: null, branch: { business: { ownerId: userId } } },
        _avg: { rating: true },
        _count: true,
      }),
      this.prisma.event.count({
        where: {
          business: { ownerId: userId },
          status: EventStatus.PUBLISHED,
          deletedAt: null,
          startAt: { gte: new Date() },
        },
      }),
      this.prisma.businessClaim.count({ where: { claimantId: userId, status: ClaimStatus.PENDING } }),
      // Averaged across all of the owner's businesses — the dashboard headline
      // number. The full per-business breakdown lives at GET /me/health-score.
      this.prisma.businessHealthScore.aggregate({
        where: { business: { ownerId: userId, deletedAt: null } },
        _avg: { overallScore: true },
        _count: true,
      }),
      this.prisma.businessRecommendation.count({
        where: { isCompleted: false, healthScore: { business: { ownerId: userId, deletedAt: null } } },
      }),
    ]);

    return {
      businessCount,
      totalReviews: reviewAgg._count,
      avgRating: reviewAgg._avg.rating ?? 0,
      upcomingEvents,
      pendingClaims,
      healthScore: {
        // null rather than 0 when nothing is scored yet — a real zero and "no
        // data" mean very different things to an owner.
        average: healthAgg._count === 0 ? null : Math.round(healthAgg._avg.overallScore ?? 0),
        businessesScored: healthAgg._count,
        openRecommendations,
      },
    };
  }

  // ============================================================================
  // BUSINESSES
  // ============================================================================

  findMyBusinesses(userId: number) {
    return this.prisma.business.findMany({
      where: { ownerId: userId, deletedAt: null },
      orderBy: { createdAt: 'desc' },
      include: {
        category: { select: { id: true, slug: true, nameUz: true } },
        businessType: { select: { id: true, slug: true, nameUz: true } },
        // Primary branch only — the "Mening bizneslarim" list card needs one
        // district/address/hours to show, not every branch. Full branch list
        // is still available via GET /me/businesses/:id.
        branches: {
          where: { deletedAt: null },
          orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }],
          take: 1,
          include: {
            district: { select: { id: true, slug: true, nameUz: true, nameRu: true, nameEn: true } },
            city: { select: { id: true, slug: true, nameUz: true, nameRu: true, nameEn: true } },
            hours: { orderBy: { dayOfWeek: 'asc' } },
          },
        },
        _count: { select: { branches: { where: { deletedAt: null } } } },
      },
    });
  }

  async findMyBusinessById(userId: number, id: number) {
    const business = await this.prisma.business.findFirst({
      where: { id, ownerId: userId, deletedAt: null },
      include: {
        category: true,
        businessType: true,
        branches: {
          where: { deletedAt: null },
          orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }],
          include: {
            hours: { orderBy: { dayOfWeek: 'asc' } },
            photos: { orderBy: { sortOrder: 'asc' } },
            district: { select: { id: true, slug: true, nameUz: true } },
            city: { select: { id: true, slug: true, nameUz: true } },
          },
        },
        products: { where: { deletedAt: null }, orderBy: { sortOrder: 'asc' } },
        events: { where: { deletedAt: null }, orderBy: { startAt: 'asc' } },
      },
    });

    if (!business) {
      throw new NotFoundException(`Business ${id} not found`);
    }

    // Reviews live on Branch, not Business — same flattening as the public
    // detail endpoint, but unfiltered by status since this is the owner's
    // own management view (they should see PENDING/HIDDEN too).
    const reviews = await this.prisma.review.findMany({
      where: { deletedAt: null, branch: { businessId: business.id } },
      orderBy: { createdAt: 'desc' },
      include: {
        user: { select: { id: true, fullName: true, avatarUrl: true } },
        reply: true,
        branch: { select: { id: true, name: true } },
      },
    });

    return { ...business, reviews };
  }

  async createMyBusiness(user: AuthenticatedUser, dto: CreateMyBusinessDto) {
    const category = await this.prisma.category.findFirst({ where: { id: dto.categoryId, deletedAt: null } });
    if (!category) throw new NotFoundException(`Category ${dto.categoryId} not found`);

    const businessType = await this.prisma.businessType.findUnique({ where: { id: dto.businessTypeId } });
    if (!businessType) throw new NotFoundException(`Business type ${dto.businessTypeId} not found`);

    const slug = await this.generateUniqueBusinessSlug(dto.name);

    return this.prisma.$transaction(async (tx) => {
      const business = await tx.business.create({
        data: {
          ownerId: user.id,
          categoryId: dto.categoryId,
          businessTypeId: dto.businessTypeId,
          slug,
          name: dto.name,
          description: dto.description,
          website: dto.website,
          email: dto.email,
          telegram: dto.telegram,
          instagram: dto.instagram,
          status: BusinessStatus.PENDING,
        },
      });

      // NOTE: CUSTOMER -> BUSINESS_OWNER promotion does NOT happen here
      // anymore. A submitted business is only PENDING review — the
      // submitter's role stays whatever it was until an admin/moderator
      // approves the listing (see AdminService.approveBusiness), so a
      // rejected submission never left a stray role change behind.

      return business;
    });
  }

  async updateMyBusiness(userId: number, id: number, dto: UpdateMyBusinessDto) {
    await this.getOwnedBusiness(userId, id);

    if (dto.categoryId != null) {
      const category = await this.prisma.category.findFirst({ where: { id: dto.categoryId, deletedAt: null } });
      if (!category) throw new NotFoundException(`Category ${dto.categoryId} not found`);
    }

    const updated = await this.prisma.business.update({ where: { id }, data: { ...dto } });

    // Editing description/telegram/instagram/cover directly moves profileScore,
    // so the owner sees the number react to the change they just made.
    await this.healthScoreService.recalculateSafely(id);

    return updated;
  }

  // Phase 16I (16D remainder, D-79): the owner's way back from REJECTED. The
  // owner fixes the listing through PATCH /me/businesses/:id (open in every
  // status), then sends it back to the moderation queue here. This is the only
  // status transition an owner makes, and only REJECTED -> PENDING; every
  // other move belongs to staff. rejectionReason is kept, not cleared: it is
  // the moderator's context for the re-review (approve clears it, a second
  // reject overwrites it), and the owner UI shows it only on REJECTED and
  // SUSPENDED listings.
  async resubmitMyBusiness(userId: number, id: number) {
    return this.prisma.$transaction(async (tx) => {
      const business = await tx.business.findFirst({ where: { id, ownerId: userId, deletedAt: null } });
      if (!business) {
        throw new NotFoundException(`Business ${id} not found`);
      }
      if (business.status !== BusinessStatus.REJECTED) {
        throw new ConflictException(
          `Only a rejected listing can be resubmitted (current status: ${business.status})`,
        );
      }

      // Compare-and-set (D-60): a double submit, or a SUPER_ADMIN hiding the
      // listing in between, must not be overwritten by a stale read.
      const { count } = await tx.business.updateMany({
        where: { id, ownerId: userId, status: BusinessStatus.REJECTED, deletedAt: null },
        data: { status: BusinessStatus.PENDING },
      });
      if (count === 0) {
        throw new ConflictException(`Business ${id} changed status concurrently`);
      }

      // Audited like the staff decisions it answers, in the same transaction.
      await tx.auditLog.create({
        data: {
          ...auditRequestFields(),
          actorId: userId,
          action: AuditAction.UPDATE,
          entityType: 'Business',
          entityId: id,
          before: { status: business.status, rejectionReason: business.rejectionReason } as Prisma.InputJsonValue,
          after: { status: BusinessStatus.PENDING, resubmitted: true } as Prisma.InputJsonValue,
        },
      });

      return tx.business.findUniqueOrThrow({ where: { id } });
    });
  }

  private async generateUniqueBusinessSlug(name: string): Promise<string> {
    // Cyrillic transliterated, never empty, never all digits (Phase 16F.2).
    const base = slugBase(name, 'business');
    let slug = base;
    let suffix = 1;
    while (await this.prisma.business.findUnique({ where: { slug } })) {
      suffix += 1;
      slug = `${base}-${suffix}`;
    }
    return slug;
  }

  private async getOwnedBusiness(userId: number, id: number) {
    const business = await this.prisma.business.findFirst({ where: { id, ownerId: userId, deletedAt: null } });
    if (!business) {
      throw new NotFoundException(`Business ${id} not found`);
    }
    return business;
  }

  // ============================================================================
  // BRANCHES
  // ============================================================================

  async createBranch(userId: number, businessId: number, dto: CreateBranchDto) {
    await this.getOwnedBusiness(userId, businessId);

    const district = await this.prisma.district.findUnique({ where: { id: dto.districtId } });
    if (!district) throw new NotFoundException(`District ${dto.districtId} not found`);

    if (dto.cityId) {
      const city = await this.prisma.city.findUnique({ where: { id: dto.cityId } });
      if (!city) throw new NotFoundException(`City ${dto.cityId} not found`);
    }

    const existingBranchCount = await this.prisma.branch.count({ where: { businessId, deletedAt: null } });
    const slug = await this.generateUniqueBranchSlug(businessId, dto.name);

    const branch = await this.prisma.$transaction(async (tx) => {
      const branch = await tx.branch.create({
        data: {
          businessId,
          districtId: dto.districtId,
          cityId: dto.cityId,
          name: dto.name,
          slug,
          address: dto.address,
          landmark: dto.landmark,
          phone: dto.phone,
          phoneAlt: dto.phoneAlt,
          // The first branch is always primary — a business can't have zero
          // primary branches, regardless of what the client sends.
          isPrimary: existingBranchCount === 0 ? true : (dto.isPrimary ?? false),
        },
      });

      if (dto.isPrimary && existingBranchCount > 0) {
        await tx.branch.updateMany({
          where: { businessId, id: { not: branch.id } },
          data: { isPrimary: false },
        });
      }

      // branchCount had no writer anywhere in the codebase until this
      // endpoint — it's the first place branches are created through the
      // app layer rather than seeded directly.
      await tx.business.update({
        where: { id: businessId },
        data: { branchCount: { increment: 1 } },
      });

      return branch;
    });

    // Deliberately after the commit rather than inside it: a new branch with no
    // hours, no landmark and no photos usually LOWERS the profile score, and
    // that verdict should be based on committed state.
    await this.healthScoreService.recalculateSafely(businessId);

    return branch;
  }

  async updateBranch(userId: number, branchId: number, dto: UpdateBranchDto) {
    const branch = await this.prisma.branch.findFirst({
      where: { id: branchId, deletedAt: null },
      include: { business: true },
    });
    if (!branch || branch.business.ownerId !== userId) {
      throw new NotFoundException(`Branch ${branchId} not found`);
    }

    if (dto.districtId != null) {
      const district = await this.prisma.district.findUnique({ where: { id: dto.districtId } });
      if (!district) throw new NotFoundException(`District ${dto.districtId} not found`);
    }

    const updated = await this.prisma.$transaction(async (tx) => {
      if (dto.isPrimary) {
        await tx.branch.updateMany({
          where: { businessId: branch.businessId, id: { not: branchId } },
          data: { isPrimary: false },
        });
      }

      await tx.branch.update({
        where: { id: branchId },
        data: {
          address: dto.address,
          landmark: dto.landmark,
          phone: dto.phone,
          phoneAlt: dto.phoneAlt,
          isPrimary: dto.isPrimary,
          districtId: dto.districtId,
        },
      });

      if (dto.hours?.length) {
        for (const hour of dto.hours) {
          await tx.branchHour.upsert({
            where: { branchId_dayOfWeek: { branchId, dayOfWeek: hour.dayOfWeek } },
            update: {
              openTime: hour.openTime,
              closeTime: hour.closeTime,
              isClosed: hour.isClosed ?? false,
              is24Hours: hour.is24Hours ?? false,
            },
            create: {
              branchId,
              dayOfWeek: hour.dayOfWeek,
              openTime: hour.openTime,
              closeTime: hour.closeTime,
              isClosed: hour.isClosed ?? false,
              is24Hours: hour.is24Hours ?? false,
            },
          });
        }
      }

      return tx.branch.findUnique({
        where: { id: branchId },
        include: { hours: { orderBy: { dayOfWeek: 'asc' } } },
      });
    });

    // Filling in hours or a landmark is exactly what the PROFILE_HOURS and
    // PROFILE_LANDMARK recommendations ask for — recalculating here is what
    // clears them from the owner's list.
    await this.healthScoreService.recalculateSafely(branch.businessId);

    return updated;
  }

  private async generateUniqueBranchSlug(businessId: number, name: string): Promise<string> {
    const base = slugBase(name, 'branch');
    let slug = base;
    let suffix = 1;
    while (await this.prisma.branch.findUnique({ where: { businessId_slug: { businessId, slug } } })) {
      suffix += 1;
      slug = `${base}-${suffix}`;
    }
    return slug;
  }

  // ============================================================================
  // REVIEWS
  // ============================================================================

  async findMyReviews(userId: number, query: PaginationQueryDto) {
    const { page, limit } = query;
    const where: Prisma.ReviewWhereInput = { deletedAt: null, branch: { business: { ownerId: userId } } };

    const [data, total] = await this.prisma.$transaction([
      this.prisma.review.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
        include: {
          user: { select: { id: true, fullName: true, avatarUrl: true } },
          reply: true,
          branch: { select: { id: true, name: true, business: { select: { id: true, slug: true, name: true } } } },
        },
      }),
      this.prisma.review.count({ where }),
    ]);

    return { data, meta: paginate(page, limit, total) };
  }

  // Ownership + role are already enforced inside ReviewsService.reply.
  replyToReview(id: number, user: AuthenticatedUser, dto: CreateReplyDto) {
    return this.reviewsService.reply(id, user, dto);
  }

  // ============================================================================
  // EVENTS
  // ============================================================================

  async findMyEvents(userId: number, query: PaginationQueryDto) {
    const { page, limit } = query;
    const where: Prisma.EventWhereInput = { deletedAt: null, business: { ownerId: userId } };

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

  // Ownership, businessType.eventsEnabled, and district derivation are
  // already enforced inside EventsService.create.
  createMyEvent(user: AuthenticatedUser, dto: CreateEventDto) {
    return this.eventsService.create(user, dto);
  }

  async updateMyEvent(userId: number, id: number, dto: UpdateMyEventDto) {
    const event = await this.prisma.event.findFirst({
      where: { id, deletedAt: null },
      include: { business: true },
    });
    if (!event || event.business.ownerId !== userId) {
      throw new NotFoundException(`Event ${id} not found`);
    }

    const startAt = dto.startAt ? new Date(dto.startAt) : event.startAt;
    const endAt = dto.endAt ? new Date(dto.endAt) : event.endAt;
    if (endAt <= startAt) {
      throw new BadRequestException('endAt must be after startAt');
    }

    // Editing a live event sends it back through moderation. Without this,
    // an owner could get bland content approved and then swap in something
    // else post-approval with no review.
    const wasPublished = event.status === EventStatus.PUBLISHED;

    return this.prisma.event.update({
      where: { id },
      data: {
        ...dto,
        startAt: dto.startAt ? startAt : undefined,
        endAt: dto.endAt ? endAt : undefined,
        ...(wasPublished ? { status: EventStatus.PENDING, publishedAt: null } : {}),
      },
    });
  }

  async removeMyEvent(userId: number, id: number) {
    const event = await this.prisma.event.findFirst({
      where: { id, deletedAt: null },
      include: { business: true },
    });
    if (!event || event.business.ownerId !== userId) {
      throw new NotFoundException(`Event ${id} not found`);
    }

    await this.prisma.event.update({ where: { id }, data: { deletedAt: new Date() } });
    return { success: true };
  }

  // ============================================================================
  // CLAIMS
  // ============================================================================

  async findMyClaims(userId: number, query: PaginationQueryDto) {
    const { page, limit } = query;
    const where: Prisma.BusinessClaimWhereInput = { claimantId: userId };

    const [data, total] = await this.prisma.$transaction([
      this.prisma.businessClaim.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
        include: {
          business: { select: { id: true, slug: true, name: true } },
          reviewedBy: { select: { id: true, fullName: true } },
        },
      }),
      this.prisma.businessClaim.count({ where }),
    ]);

    return { data, meta: paginate(page, limit, total) };
  }

  // A claim establishes "I represent this listing" for a business the
  // directory already carries with no owner (ownerId null, e.g. seeded or
  // added by an admin). This is distinct from POST /me/businesses, which
  // creates a brand-new listing that is owned by its submitter from the
  // start — there is nothing to "claim" there.
  async createClaim(user: AuthenticatedUser, dto: CreateClaimDto) {
    const business = await this.prisma.business.findFirst({
      where: { id: dto.businessId, deletedAt: null },
    });
    if (!business) {
      throw new NotFoundException(`Business ${dto.businessId} not found`);
    }
    if (business.status !== BusinessStatus.APPROVED) {
      throw new BadRequestException('Only an approved, publicly listed business can be claimed');
    }
    if (business.ownerId !== null) {
      throw new ConflictException('This business is already claimed');
    }

    const existingPending = await this.prisma.businessClaim.findFirst({
      where: { businessId: dto.businessId, claimantId: user.id, status: ClaimStatus.PENDING },
    });
    if (existingPending) {
      throw new ConflictException(DUPLICATE_PENDING_CLAIM);
    }

    // Filing a claim is audited like the staff decision on it (Phase 16C.1),
    // in the same transaction so a claim never exists without its row. The
    // audit row records only which business and the resulting status — the
    // claimant's evidence and contact details stay on the claim itself
    // (readable by the claimant and `claim.review` holders) rather than being
    // copied into the broader audit log.
    try {
      return await this.prisma.$transaction(async (tx) => {
        await this.lockClaimableBusiness(tx, dto.businessId);

        const claim = await tx.businessClaim.create({
          data: {
            businessId: dto.businessId,
            claimantId: user.id,
            evidence: dto.evidence,
            contactPhone: dto.contactPhone,
            contactNote: dto.contactNote,
          },
          include: {
            business: { select: { id: true, slug: true, name: true } },
          },
        });

        await tx.auditLog.create({
          data: {
            ...auditRequestFields(),
            actorId: user.id,
            action: AuditAction.CREATE,
            entityType: 'BusinessClaim',
            entityId: claim.id,
            before: {} as Prisma.InputJsonValue,
            after: { businessId: claim.businessId, status: claim.status } as Prisma.InputJsonValue,
          },
        });

        return claim;
      });
    } catch (error) {
      // Phase 16H: the reads above are friendly pre-checks, not the guarantee.
      // A concurrent duplicate (double submit, retried request) passes them
      // too; the partial unique index business_claims_one_pending_per_claimant
      // refuses its INSERT, and that is reported as the same 409.
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new ConflictException(DUPLICATE_PENDING_CLAIM);
      }
      throw error;
    }
  }

  // Phase 16H: re-checks "approved, unowned, not deleted" under a shared lock
  // on the business row, inside the claim's transaction. AdminService.
  // approveClaim assigns the owner with an UPDATE of that same row, so the two
  // serialize: if the approval commits first, the locked re-read sees the new
  // owner and this claim is refused; if this claim holds the lock first, the
  // approval waits, and its "reject every other pending claim" step (a later
  // statement, so a fresh snapshot) then finds and closes this one. Either way
  // no PENDING claim is left behind on a listing that already has an owner.
  // FOR SHARE, not FOR UPDATE: concurrent claims on one listing don't block
  // each other — only ownership changes wait.
  private async lockClaimableBusiness(tx: Prisma.TransactionClient, businessId: number) {
    const claimable = await tx.$queryRaw<Array<{ id: number }>>`
      SELECT id FROM businesses
      WHERE id = ${businessId} AND owner_id IS NULL AND status = 'APPROVED' AND deleted_at IS NULL
      FOR SHARE`;
    if (claimable.length === 0) {
      throw new ConflictException('This business is already claimed or no longer open to claims');
    }
  }
}
