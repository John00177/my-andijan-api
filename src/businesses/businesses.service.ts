import { Injectable, NotFoundException } from '@nestjs/common';
import { BusinessStatus, EventStatus, Prisma, ReviewStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { OwnerService } from '../owner/owner.service';
import { AuthenticatedUser } from '../auth/strategies/jwt.strategy';
import { ListBusinessesQueryDto } from './dto/list-businesses-query.dto';
import { CreateBusinessDto } from './dto/create-business.dto';

// Shared shape for every list-style endpoint (list/featured/promoted): the
// primary branch is resolved server-side so clients never have to reason
// about which of a business's branches to show as "the" address.
const LIST_SELECT = {
  id: true,
  slug: true,
  name: true,
  logoUrl: true,
  coverUrl: true,
  ratingAvg: true,
  reviewCount: true,
  branchCount: true,
  viewCount: true,
  favoriteCount: true,
  isPromoted: true,
  isFeatured: true,
  category: {
    select: { id: true, slug: true, nameUz: true, nameRu: true, nameEn: true },
  },
  branches: {
    where: { deletedAt: null },
    orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }],
    take: 1,
    select: {
      id: true,
      name: true,
      address: true,
      phone: true,
      district: { select: { id: true, slug: true, nameUz: true } },
      city: { select: { id: true, slug: true, nameUz: true } },
    },
  },
} satisfies Prisma.BusinessSelect;

type ListRow = Prisma.BusinessGetPayload<{ select: typeof LIST_SELECT }>;

@Injectable()
export class BusinessesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ownerService: OwnerService,
  ) {}

  // ============================================================================
  // CREATE  (POST /businesses)
  //
  // Thin orchestrator, not a parallel implementation: delegates to the same
  // OwnerService methods POST /me/businesses and POST /me/businesses/:id/branches
  // already use, so slug generation, CUSTOMER->BUSINESS_OWNER auto-promotion,
  // and health-score recalculation all stay in one place. This exists because
  // the frontend's Add Business form collects business + primary-branch fields
  // in a single submit — Business itself intentionally holds no location data
  // (see the Business/Branch split above), so this call still results in two
  // writes, just issued back-to-back from one request instead of two.
  //
  // Not a single atomic transaction across both writes: if branch creation
  // fails after the business is created, the business is left as a valid
  // PENDING row with no branch yet, recoverable via POST
  // /me/businesses/:id/branches rather than silently orphaned.
  // ============================================================================

  async createForOwner(user: AuthenticatedUser, dto: CreateBusinessDto) {
    const businessTypeId = dto.businessTypeId ?? (await this.getDefaultBusinessTypeId());

    const business = await this.ownerService.createMyBusiness(user, {
      categoryId: dto.categoryId,
      businessTypeId,
      name: dto.name,
      description: dto.description,
      website: dto.website,
      email: dto.email,
      telegram: dto.telegram,
      instagram: dto.instagram,
    });

    const branch = await this.ownerService.createBranch(user.id, business.id, {
      districtId: dto.districtId,
      cityId: dto.cityId,
      name: dto.name,
      address: dto.address,
      landmark: dto.landmark,
      phone: dto.phone,
      phoneAlt: dto.secondaryPhone,
      isPrimary: true,
    });

    if (dto.hours?.length) {
      await this.ownerService.updateBranch(user.id, branch.id, {
        hours: dto.hours.map((hour) => ({
          dayOfWeek: hour.day,
          openTime: hour.openTime ?? undefined,
          closeTime: hour.closeTime ?? undefined,
          isClosed: hour.isClosed ?? false,
        })),
      });
    }

    return this.ownerService.findMyBusinessById(user.id, business.id);
  }

  private async getDefaultBusinessTypeId(): Promise<number> {
    const businessType = await this.prisma.businessType.findFirst({
      where: { isActive: true },
      orderBy: { sortOrder: 'asc' },
    });
    if (!businessType) {
      throw new NotFoundException('No active business types configured');
    }
    return businessType.id;
  }

  async findAll(query: ListBusinessesQueryDto) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;

    const where: Prisma.BusinessWhereInput = {
      status: BusinessStatus.APPROVED,
      deletedAt: null,
      ...(query.category ? { category: { slug: query.category } } : {}),
      ...(query.district ? { branches: { some: { districtId: query.district, deletedAt: null } } } : {}),
      ...(query.city ? { branches: { some: { cityId: query.city, deletedAt: null } } } : {}),
      ...(query.search
        ? { name: { contains: query.search, mode: Prisma.QueryMode.insensitive } }
        : {}),
    };

    const [businesses, total] = await this.prisma.$transaction([
      this.prisma.business.findMany({
        where,
        select: LIST_SELECT,
        orderBy: [{ isPromoted: 'desc' }, { ratingAvg: 'desc' }, { id: 'asc' }],
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.business.count({ where }),
    ]);

    return {
      data: businesses.map((b) => this.toListItem(b)),
      meta: { page, limit, total, totalPages: Math.ceil(total / limit) || 1 },
    };
  }

  async findFeatured() {
    const businesses = await this.prisma.business.findMany({
      where: {
        status: BusinessStatus.APPROVED,
        deletedAt: null,
        isFeatured: true,
        OR: [{ featuredUntil: null }, { featuredUntil: { gte: new Date() } }],
      },
      select: LIST_SELECT,
      orderBy: [{ ratingAvg: 'desc' }, { id: 'asc' }],
      take: 50,
    });

    return businesses.map((b) => this.toListItem(b));
  }

  async findPromoted() {
    const businesses = await this.prisma.business.findMany({
      where: {
        status: BusinessStatus.APPROVED,
        deletedAt: null,
        isPromoted: true,
        OR: [{ promotedUntil: null }, { promotedUntil: { gte: new Date() } }],
      },
      select: LIST_SELECT,
      orderBy: [{ ratingAvg: 'desc' }, { id: 'asc' }],
      take: 50,
    });

    return businesses.map((b) => this.toListItem(b));
  }

  async findBySlug(slug: string) {
    const business = await this.prisma.business.findFirst({
      where: { slug, status: BusinessStatus.APPROVED, deletedAt: null },
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
        products: {
          where: { isActive: true, deletedAt: null },
          orderBy: { sortOrder: 'asc' },
        },
        events: {
          where: { status: EventStatus.PUBLISHED, deletedAt: null },
          orderBy: { startAt: 'asc' },
        },
      },
    });

    if (!business) {
      throw new NotFoundException(`Business "${slug}" not found`);
    }

    // Reviews live on Branch, not Business (service quality is
    // location-specific) — pull them across every branch of this business
    // as one flat, most-recent-first list for the detail page.
    const reviews = await this.prisma.review.findMany({
      where: {
        status: ReviewStatus.PUBLISHED,
        deletedAt: null,
        branch: { businessId: business.id },
      },
      orderBy: { createdAt: 'desc' },
      include: {
        user: { select: { id: true, fullName: true, avatarUrl: true } },
        reply: true,
        branch: { select: { id: true, name: true } },
      },
    });

    return {
      ...business,
      products: business.businessType.catalogEnabled ? business.products : [],
      events: business.businessType.eventsEnabled ? business.events : [],
      reviews,
    };
  }

  private toListItem(business: ListRow) {
    const { branches, ...rest } = business;
    return { ...rest, primaryBranch: branches[0] ?? null };
  }
}
