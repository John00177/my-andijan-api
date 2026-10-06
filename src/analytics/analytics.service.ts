import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { BusinessStatus, Prisma, ReviewStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { incrementBusinessViewCount } from '../common/counters';
import { RecordViewDto } from './dto/record-view.dto';
import { AnalyticsClickAction, RecordClickDto } from './dto/record-click.dto';
import { RecordSearchDto } from './dto/record-search.dto';
import { TrafficPeriod, TrafficQueryDto } from './dto/traffic-query.dto';

function dateOnly(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

function addDays(d: Date, days: number): Date {
  const copy = new Date(d);
  copy.setUTCDate(copy.getUTCDate() + days);
  return copy;
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

// previous === 0 has no well-defined percentage change (division by zero).
// Convention used here, matching common product-analytics dashboards:
// 0 -> 0 is "0%", 0 -> N>0 is displayed as "+100%" rather than "∞%".
function formatPercentChange(current: number, previous: number): string {
  if (previous === 0) {
    return current === 0 ? '0%' : '+100%';
  }
  const pct = Math.round(((current - previous) / previous) * 100);
  return `${pct >= 0 ? '+' : ''}${pct}%`;
}

function formatDelta(diff: number): string {
  const rounded = round1(diff);
  return `${rounded >= 0 ? '+' : ''}${rounded.toFixed(1)}`;
}

const CLICK_FIELD: Record<AnalyticsClickAction, string> = {
  [AnalyticsClickAction.CALL]: 'callClicks',
  [AnalyticsClickAction.DIRECTION]: 'directionClicks',
  [AnalyticsClickAction.FAVORITE]: 'favoriteClicks',
  [AnalyticsClickAction.SHARE]: 'shareClicks',
  [AnalyticsClickAction.WEBSITE]: 'websiteClicks',
};

// ActivityLog.actionType names for each click, per the schema's documented
// vocabulary. SHARE/WEBSITE have no listed name, so they follow the same
// <NOUN>_CLICKED convention.
const CLICK_ACTIVITY_TYPE: Record<AnalyticsClickAction, string> = {
  [AnalyticsClickAction.CALL]: 'CALL_CLICKED',
  [AnalyticsClickAction.DIRECTION]: 'DIRECTION_CLICKED',
  [AnalyticsClickAction.FAVORITE]: 'FAVORITE_ADDED',
  [AnalyticsClickAction.SHARE]: 'SHARE_CLICKED',
  [AnalyticsClickAction.WEBSITE]: 'WEBSITE_CLICKED',
};

@Injectable()
export class AnalyticsService {
  constructor(private readonly prisma: PrismaService) {}

  // ============================================================================
  // COLLECTION (public, anonymous)
  // ============================================================================

  async recordView(dto: RecordViewDto) {
    await this.getVisibleBusiness(dto.businessId);
    if (dto.cityId) {
      await this.assertCityExists(dto.cityId);
    }

    const date = dateOnly(new Date());

    await this.prisma.$transaction(async (tx) => {
      await tx.businessAnalytics.upsert({
        where: { businessId_date: { businessId: dto.businessId, date } },
        update: {
          pageViews: { increment: 1 },
          ...(dto.cityId ? { visitorCities: { push: dto.cityId } } : {}),
        },
        create: {
          businessId: dto.businessId,
          date,
          pageViews: 1,
          visitorCities: dto.cityId ? [dto.cityId] : [],
        },
      });
      // viewCount existed on Business already but had no writer anywhere in
      // the codebase — this is the first endpoint that actually records a
      // view, so it's the natural place to finally maintain it. A plain SQL
      // increment (Phase 16F.6): a page view is not an edit, so it must not
      // move the business's updatedAt (sitemap lastmod).
      await incrementBusinessViewCount(tx, dto.businessId);
      // Raw event stream for the platform command center.
      await tx.activityLog.create({
        data: {
          actionType: 'BUSINESS_VIEWED',
          businessId: dto.businessId,
          metadata: dto.cityId ? { cityId: dto.cityId } : Prisma.JsonNull,
        },
      });
    });

    return { success: true };
  }

  async recordClick(dto: RecordClickDto) {
    await this.getVisibleBusiness(dto.businessId);
    const date = dateOnly(new Date());
    const field = CLICK_FIELD[dto.action];

    await this.prisma.$transaction([
      this.prisma.businessAnalytics.upsert({
        where: { businessId_date: { businessId: dto.businessId, date } },
        update: { [field]: { increment: 1 } } as Prisma.BusinessAnalyticsUncheckedUpdateInput,
        create: { businessId: dto.businessId, date, [field]: 1 } as Prisma.BusinessAnalyticsUncheckedCreateInput,
      }),
      this.prisma.activityLog.create({
        data: { actionType: CLICK_ACTIVITY_TYPE[dto.action], businessId: dto.businessId },
      }),
    ]);

    return { success: true };
  }

  async recordSearch(dto: RecordSearchDto) {
    if (dto.businessId) {
      await this.getVisibleBusiness(dto.businessId);
    }

    // Canonical search log (SearchQueryLog is deprecated — see schema.prisma).
    await this.prisma.$transaction([
      this.prisma.searchAnalytics.create({
        data: {
          query: dto.query,
          businessId: dto.businessId,
          categoryId: dto.categoryId,
          districtId: dto.districtId,
          cityId: dto.cityId,
          resultCount: dto.resultCount,
        },
      }),
      this.prisma.activityLog.create({
        data: {
          actionType: 'SEARCH_PERFORMED',
          businessId: dto.businessId,
          metadata: { query: dto.query, resultCount: dto.resultCount },
        },
      }),
    ]);

    // Only attributed searches (businessId given) feed the per-business
    // "top search terms" field — a bare platform-wide search isn't about any
    // one business.
    if (dto.businessId) {
      const date = dateOnly(new Date());
      await this.prisma.businessAnalytics.upsert({
        where: { businessId_date: { businessId: dto.businessId, date } },
        update: { searchQueries: { push: dto.query } },
        create: { businessId: dto.businessId, date, searchQueries: [dto.query] },
      });
    }

    return { success: true };
  }

  private async getVisibleBusiness(id: number) {
    const business = await this.prisma.business.findFirst({
      where: { id, status: BusinessStatus.APPROVED, deletedAt: null },
    });
    if (!business) {
      throw new NotFoundException(`Business ${id} not found`);
    }
    return business;
  }

  private async assertCityExists(id: number) {
    const city = await this.prisma.city.findUnique({ where: { id } });
    if (!city) {
      throw new NotFoundException(`City ${id} not found`);
    }
  }

  // ============================================================================
  // OWNER ANALYTICS (JWT + ownership)
  // ============================================================================

  async getOverview(userId: number, businessId?: number) {
    const businessIds = await this.resolveOwnedBusinessIds(userId, businessId);
    if (businessIds.length === 0) {
      return this.emptyOverview();
    }

    const today = dateOnly(new Date());
    const currentStart = addDays(today, -6); // current window: [today-6, today]
    const previousEnd = addDays(today, -7);
    const previousStart = addDays(today, -13); // previous window: [today-13, today-7]

    const [currentAgg, previousAgg, currentRating, previousRating] = await Promise.all([
      this.sumAnalytics(businessIds, currentStart, today),
      this.sumAnalytics(businessIds, previousStart, previousEnd),
      this.avgRatingAsOf(businessIds, new Date()),
      this.avgRatingAsOf(businessIds, addDays(new Date(), -7)),
    ]);

    return {
      pageViews: this.compareMetric(currentAgg.pageViews, previousAgg.pageViews),
      callClicks: this.compareMetric(currentAgg.callClicks, previousAgg.callClicks),
      directionClicks: this.compareMetric(currentAgg.directionClicks, previousAgg.directionClicks),
      favorites: this.compareMetric(currentAgg.favoriteClicks, previousAgg.favoriteClicks),
      avgRating: {
        current: round1(currentRating),
        previous: round1(previousRating),
        change: formatDelta(currentRating - previousRating),
      },
    };
  }

  async getTraffic(userId: number, query: TrafficQueryDto) {
    const businessIds = await this.resolveOwnedBusinessIds(userId, query.businessId);
    const days = query.period === TrafficPeriod.NINETY_DAYS ? 90 : query.period === TrafficPeriod.THIRTY_DAYS ? 30 : 7;

    const end = dateOnly(new Date());
    const start = addDays(end, -(days - 1));

    const byDate = new Map<string, number>();
    if (businessIds.length > 0) {
      const rows = await this.prisma.businessAnalytics.groupBy({
        by: ['date'],
        where: { businessId: { in: businessIds }, date: { gte: start, lte: end } },
        _sum: { pageViews: true },
      });
      for (const row of rows) {
        byDate.set(isoDate(row.date), row._sum.pageViews ?? 0);
      }
    }

    const series: { date: string; views: number }[] = [];
    for (let i = 0; i < days; i++) {
      const key = isoDate(addDays(start, i));
      series.push({ date: key, views: byDate.get(key) ?? 0 });
    }
    return series;
  }

  async getDemographics(userId: number, businessId?: number) {
    const businessIds = await this.resolveOwnedBusinessIds(userId, businessId);
    if (businessIds.length === 0) {
      return { topCities: [], topDistricts: [] };
    }

    const rows = await this.prisma.businessAnalytics.findMany({
      where: { businessId: { in: businessIds } },
      select: { visitorCities: true },
    });

    const cityCounts = new Map<number, number>();
    let total = 0;
    for (const row of rows) {
      for (const cityId of row.visitorCities) {
        cityCounts.set(cityId, (cityCounts.get(cityId) ?? 0) + 1);
        total++;
      }
    }

    if (total === 0) {
      return { topCities: [], topDistricts: [] };
    }

    const cities = await this.prisma.city.findMany({
      where: { id: { in: [...cityCounts.keys()] } },
      select: { id: true, nameUz: true, districtId: true },
    });
    const cityById = new Map(cities.map((c) => [c.id, c]));

    const topCities = [...cityCounts.entries()]
      .map(([cityId, count]) => ({
        city: cityById.get(cityId)?.nameUz ?? `City ${cityId}`,
        percentage: Math.round((count / total) * 100),
      }))
      .sort((a, b) => b.percentage - a.percentage);

    // Region-level cities (e.g. Andijon) have no parent district, so they're
    // excluded from the district breakdown — there's nothing to attribute
    // them to.
    const districtCounts = new Map<number, number>();
    let districtTotal = 0;
    for (const [cityId, count] of cityCounts) {
      const districtId = cityById.get(cityId)?.districtId;
      if (districtId == null) continue;
      districtCounts.set(districtId, (districtCounts.get(districtId) ?? 0) + count);
      districtTotal += count;
    }

    let topDistricts: { district: string; percentage: number }[] = [];
    if (districtTotal > 0) {
      const districts = await this.prisma.district.findMany({
        where: { id: { in: [...districtCounts.keys()] } },
        select: { id: true, nameUz: true },
      });
      const districtById = new Map(districts.map((d) => [d.id, d]));

      topDistricts = [...districtCounts.entries()]
        .map(([districtId, count]) => ({
          district: districtById.get(districtId)?.nameUz ?? `District ${districtId}`,
          percentage: Math.round((count / districtTotal) * 100),
        }))
        .sort((a, b) => b.percentage - a.percentage);
    }

    return { topCities, topDistricts };
  }

  async getSearchTerms(userId: number, businessId?: number) {
    const businessIds = await this.resolveOwnedBusinessIds(userId, businessId);
    if (businessIds.length === 0) return [];

    const rows = await this.prisma.businessAnalytics.findMany({
      where: { businessId: { in: businessIds } },
      select: { searchQueries: true },
    });

    const counts = new Map<string, number>();
    for (const row of rows) {
      for (const term of row.searchQueries) {
        counts.set(term, (counts.get(term) ?? 0) + 1);
      }
    }

    return [...counts.entries()].map(([term, count]) => ({ term, count })).sort((a, b) => b.count - a.count);
  }

  // BusinessAnalytics is date-grain — one aggregated row per business per
  // day, with no per-view timestamp retained anywhere in the schema. There
  // is no real data this can be computed from, so rather than fabricate a
  // plausible-looking hourly distribution, this returns an explicit empty
  // result with an explanatory note. See the written report for options.
  async getPeakHours(userId: number, businessId?: number) {
    await this.resolveOwnedBusinessIds(userId, businessId);
    return {
      data: [] as { hour: string; views: number }[],
      note:
        'Hourly breakdown is not available: BusinessAnalytics stores one row per business per day and does not retain per-view timestamps. A lightweight view-event log would be needed to support this for real.',
    };
  }

  async getCompetitors(userId: number, businessId?: number) {
    const businessIds = await this.resolveOwnedBusinessIds(userId, businessId);

    let targetId: number;
    if (businessId) {
      targetId = businessId;
    } else if (businessIds.length === 1) {
      targetId = businessIds[0];
    } else if (businessIds.length === 0) {
      throw new NotFoundException('You have no businesses yet');
    } else {
      throw new BadRequestException(
        'You own multiple businesses — pass ?businessId= to see category ranking for a specific one',
      );
    }

    const business = await this.prisma.business.findFirst({ where: { id: targetId, deletedAt: null } });
    if (!business) {
      throw new NotFoundException(`Business ${targetId} not found`);
    }

    const categoryPeers = await this.prisma.business.findMany({
      where: { categoryId: business.categoryId, status: BusinessStatus.APPROVED, deletedAt: null },
      orderBy: [{ ratingAvg: 'desc' }, { reviewCount: 'desc' }],
      select: { id: true, name: true, ratingAvg: true, reviewCount: true },
    });

    const index = categoryPeers.findIndex((b) => b.id === targetId);

    return {
      // null when my own business isn't APPROVED, so it isn't in the ranked
      // list at all.
      myRank: index === -1 ? null : index + 1,
      totalInCategory: categoryPeers.length,
      topRated: categoryPeers.slice(0, 5).map((b) => ({ name: b.name, rating: b.ratingAvg })),
    };
  }

  private async resolveOwnedBusinessIds(userId: number, businessId?: number): Promise<number[]> {
    if (businessId) {
      const business = await this.prisma.business.findFirst({
        where: { id: businessId, ownerId: userId, deletedAt: null },
      });
      if (!business) {
        throw new NotFoundException(`Business ${businessId} not found`);
      }
      return [businessId];
    }

    const businesses = await this.prisma.business.findMany({
      where: { ownerId: userId, deletedAt: null },
      select: { id: true },
    });
    return businesses.map((b) => b.id);
  }

  private async sumAnalytics(businessIds: number[], start: Date, end: Date) {
    const agg = await this.prisma.businessAnalytics.aggregate({
      where: { businessId: { in: businessIds }, date: { gte: start, lte: end } },
      _sum: { pageViews: true, callClicks: true, directionClicks: true, favoriteClicks: true },
    });
    return {
      pageViews: agg._sum.pageViews ?? 0,
      callClicks: agg._sum.callClicks ?? 0,
      directionClicks: agg._sum.directionClicks ?? 0,
      favoriteClicks: agg._sum.favoriteClicks ?? 0,
    };
  }

  // ============================================================================
  // PLATFORM-WIDE USER ANALYTICS (SUPER_ADMIN only)
  // ============================================================================

  async getUserAnalytics() {
    const [totalUsers, ageGroups, genderSplitRaw, cityBreakdown] = await Promise.all([
      this.prisma.user.count({ where: { deletedAt: null } }),

      // Table/column names are the mapped ones (`users`, not the Prisma model
      // name `User`) — @@map on the model means the real Postgres relation is
      // lowercase. COUNT(*) is cast to ::int because Prisma returns raw bigint
      // aggregates as native JS BigInt, which Nest's JSON serializer can't
      // stringify.
      this.prisma.$queryRaw<{ range: string; count: number }[]>`
        SELECT
          CASE
            WHEN age BETWEEN 16 AND 25 THEN '16-25'
            WHEN age BETWEEN 26 AND 35 THEN '26-35'
            WHEN age BETWEEN 36 AND 60 THEN '36-60'
            WHEN age > 60 THEN '60+'
            ELSE 'Noma''lum'
          END as range,
          COUNT(*)::int as count
        FROM users
        WHERE deleted_at IS NULL
        GROUP BY range
        ORDER BY count DESC
      `,

      this.prisma.user.groupBy({
        by: ['gender'],
        _count: { id: true },
        where: { gender: { not: null }, deletedAt: null },
      }),

      // districtId is a foreign key to District, not Region (this platform
      // has exactly one Region — "Andijon viloyati" — so joining Region here
      // would bucket every single user into that one row). District is also
      // what the codebase already treats as the user-facing "city" concept
      // (see RegisterDto.districtId, User.district relation).
      this.prisma.$queryRaw<{ city: string; count: number }[]>`
        SELECT COALESCE(d.name_uz, 'Noma''lum') as city, COUNT(u.id)::int as count
        FROM users u
        LEFT JOIN districts d ON u.district_id = d.id
        WHERE u.deleted_at IS NULL
        GROUP BY d.name_uz
        ORDER BY count DESC
        LIMIT 20
      `,
    ]);

    const genderSplit = genderSplitRaw.map((row) => ({ gender: row.gender, count: row._count.id }));

    return { totalUsers, ageGroups, genderSplit, cityBreakdown };
  }

  // ============================================================================
  // PLATFORM DASHBOARD ANALYTICS (SUPER_ADMIN only)
  //
  // A separate endpoint/method rather than extending getUserAnalytics() in
  // place — the frontend's AnalyticsView already reads GET /admin/analytics/users
  // as a flat { totalUsers, ageGroups, genderSplit, cityBreakdown } object;
  // nesting it under a `users` key would be a breaking change to a route
  // that's already live.
  // ============================================================================

  async getDashboardAnalytics() {
    const startOfMonth = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1));

    const [userAnalytics, usersNewThisMonth, totalBusinesses, byStatusRaw, byCategory, businessesNewThisMonth] =
      await Promise.all([
        this.getUserAnalytics(),

        this.prisma.user.count({ where: { deletedAt: null, createdAt: { gte: startOfMonth } } }),

        this.prisma.business.count({ where: { deletedAt: null } }),

        this.prisma.business.groupBy({
          by: ['status'],
          _count: { id: true },
          where: { deletedAt: null },
        }),

        // Real status values are DRAFT/PENDING/APPROVED/REJECTED/SUSPENDED/HIDDEN
        // (see BusinessStatus in schema.prisma) — there is no "ACTIVE" status on
        // this platform; APPROVED is the live-and-visible state.
        this.prisma.$queryRaw<{ category: string; count: number }[]>`
          SELECT COALESCE(c.name_uz, 'Noma''lum') as category, COUNT(b.id)::int as count
          FROM businesses b
          LEFT JOIN categories c ON b.category_id = c.id
          WHERE b.deleted_at IS NULL
          GROUP BY c.name_uz
          ORDER BY count DESC
        `,

        this.prisma.business.count({
          where: { deletedAt: null, createdAt: { gte: startOfMonth } },
        }),
      ]);

    const byStatus = byStatusRaw.map((row) => ({ status: row.status, count: row._count.id }));

    return {
      users: { ...userAnalytics, newThisMonth: usersNewThisMonth },
      businesses: {
        totalBusinesses,
        byStatus,
        byCategory,
        newThisMonth: businessesNewThisMonth,
      },
    };
  }

  private compareMetric(current: number, previous: number) {
    return { current, previous, change: formatPercentChange(current, previous) };
  }

  private async avgRatingAsOf(businessIds: number[], asOf: Date) {
    const agg = await this.prisma.review.aggregate({
      where: {
        status: ReviewStatus.PUBLISHED,
        deletedAt: null,
        createdAt: { lte: asOf },
        branch: { businessId: { in: businessIds } },
      },
      _avg: { rating: true },
    });
    return agg._avg.rating ?? 0;
  }

  private emptyOverview() {
    const zero = { current: 0, previous: 0, change: '0%' };
    return {
      pageViews: zero,
      callClicks: zero,
      directionClicks: zero,
      favorites: zero,
      avgRating: { current: 0, previous: 0, change: '0.0' },
    };
  }
}
