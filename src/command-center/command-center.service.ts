import { Injectable } from '@nestjs/common';
import { BusinessStatus, ClaimStatus, EventStatus, Prisma, ReportStatus, ReviewStatus, UserRole } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AggregateDto, GrowthPeriod, GrowthQueryDto } from './dto/command-center.dto';

// Placeholder monetisation rates. There is no pricing table in the schema and
// no payments module yet (Advertisement is deferred to Phase 2), so these are
// read from PlatformSetting when present and fall back to these defaults.
// They are ESTIMATES for the founder dashboard, not billed amounts.
const DEFAULT_PROMOTED_MONTHLY_UZS = 100_000;
const DEFAULT_FEATURED_MONTHLY_UZS = 150_000;
const SETTING_PROMOTED_RATE = 'pricing.promoted_monthly_uzs';
const SETTING_FEATURED_RATE = 'pricing.featured_monthly_uzs';

const ONLINE_WINDOW_MINUTES = 15;
const CHURN_RISK_DAYS = 30;
const FLAG_REJECTED_BUSINESS_THRESHOLD = 2;

export const METRIC = {
  DAILY_ACTIVE_USERS: 'DAILY_ACTIVE_USERS',
  NEW_SIGNUPS: 'NEW_SIGNUPS',
  NEW_BUSINESSES: 'NEW_BUSINESSES',
  REVIEWS_POSTED: 'REVIEWS_POSTED',
  SEARCH_QUERIES: 'SEARCH_QUERIES',
  PAGE_VIEWS: 'PAGE_VIEWS',
  REVENUE_ESTIMATE: 'REVENUE_ESTIMATE',
} as const;

interface DayValueRow {
  d: Date;
  v: number;
}

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

function startOfToday(): Date {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate());
}

function pctChange(current: number, previous: number): string {
  if (previous === 0) return current === 0 ? '0%' : '+100%';
  const pct = Math.round(((current - previous) / previous) * 100);
  return `${pct >= 0 ? '+' : ''}${pct}%`;
}

function humanizeDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '0 hours';
  const hours = ms / 3_600_000;
  if (hours < 1) return `${Math.round(hours * 60)} minutes`;
  if (hours < 48) return `${Math.round(hours * 10) / 10} hours`;
  return `${Math.round((hours / 24) * 10) / 10} days`;
}

function toNumber(v: Prisma.Decimal | number | null | undefined): number {
  if (v == null) return 0;
  return typeof v === 'number' ? v : Number(v);
}

@Injectable()
export class CommandCenterService {
  constructor(private readonly prisma: PrismaService) {}

  // ============================================================================
  // AGGREGATION  (POST /admin/analytics/aggregate)
  //
  // Every metric is computed with ONE grouped SQL statement covering the whole
  // requested range — never one query per day, and never loading rows into
  // memory to count them in JS.
  // ============================================================================

  async aggregate(dto: AggregateDto) {
    const anchor = dto.date ? dateOnly(new Date(dto.date)) : dateOnly(addDays(new Date(), -1));
    const days = dto.backfillDays ?? 1;
    const start = addDays(anchor, -(days - 1));
    const endExclusive = addDays(anchor, 1);

    const rates = await this.getRevenueRates();

    const [signups, newBusinesses, reviews, searches, pageViews, activeUsers, revenue] = await Promise.all([
      this.prisma.$queryRaw<DayValueRow[]>`
        SELECT created_at::date AS d, count(*)::int AS v FROM users
        WHERE created_at >= ${start} AND created_at < ${endExclusive} AND deleted_at IS NULL
        GROUP BY 1`,
      this.prisma.$queryRaw<DayValueRow[]>`
        SELECT created_at::date AS d, count(*)::int AS v FROM businesses
        WHERE created_at >= ${start} AND created_at < ${endExclusive} AND deleted_at IS NULL
        GROUP BY 1`,
      this.prisma.$queryRaw<DayValueRow[]>`
        SELECT created_at::date AS d, count(*)::int AS v FROM reviews
        WHERE created_at >= ${start} AND created_at < ${endExclusive} AND deleted_at IS NULL
        GROUP BY 1`,
      this.prisma.$queryRaw<DayValueRow[]>`
        SELECT created_at::date AS d, count(*)::int AS v FROM search_analytics
        WHERE created_at >= ${start} AND created_at < ${endExclusive}
        GROUP BY 1`,
      this.prisma.$queryRaw<DayValueRow[]>`
        SELECT date AS d, coalesce(sum(page_views), 0)::int AS v FROM business_analytics
        WHERE date >= ${start} AND date <= ${anchor}
        GROUP BY 1`,
      // A "daily active user" is anyone who obtained a session that day —
      // refresh tokens are issued once per login, so distinct user_id per day
      // is an honest proxy without a real session store.
      this.prisma.$queryRaw<DayValueRow[]>`
        SELECT created_at::date AS d, count(DISTINCT user_id)::int AS v FROM refresh_tokens
        WHERE created_at >= ${start} AND created_at < ${endExclusive}
        GROUP BY 1`,
      // Promotions active on each day, priced at the daily share of the
      // monthly rate. generate_series keeps this to a single round trip.
      this.prisma.$queryRaw<{ d: Date; promoted: number; featured: number }[]>`
        SELECT gs::date AS d,
          (SELECT count(*) FROM businesses b
             WHERE b.is_promoted AND b.deleted_at IS NULL
               AND b.created_at < gs + interval '1 day'
               AND (b.promoted_until IS NULL OR b.promoted_until >= gs))::int AS promoted,
          (SELECT count(*) FROM businesses b
             WHERE b.is_featured AND b.deleted_at IS NULL
               AND b.created_at < gs + interval '1 day'
               AND (b.featured_until IS NULL OR b.featured_until >= gs))::int AS featured
        FROM generate_series(${start}::date, ${anchor}::date, '1 day') gs`,
    ]);

    const revenueRows: DayValueRow[] = revenue.map((r) => ({
      d: r.d,
      v: Math.round((r.promoted * rates.promoted + r.featured * rates.featured) / 30),
    }));

    const written = await this.persistMetrics([
      [METRIC.NEW_SIGNUPS, signups],
      [METRIC.NEW_BUSINESSES, newBusinesses],
      [METRIC.REVIEWS_POSTED, reviews],
      [METRIC.SEARCH_QUERIES, searches],
      [METRIC.PAGE_VIEWS, pageViews],
      [METRIC.DAILY_ACTIVE_USERS, activeUsers],
      [METRIC.REVENUE_ESTIMATE, revenueRows],
    ]);

    return {
      from: isoDate(start),
      to: isoDate(anchor),
      daysProcessed: days,
      metricsWritten: written,
    };
  }

  // Only days that actually had activity get a row — writing explicit zeros
  // for every metric × every day would be mostly-empty bloat. getGrowth()
  // fills the gaps with 0 at read time instead.
  private async persistMetrics(sets: [string, DayValueRow[]][]) {
    let count = 0;
    for (const [metricType, rows] of sets) {
      const byDate = new Map(rows.map((r) => [isoDate(new Date(r.d)), r.v]));
      for (const [dateKey, value] of byDate) {
        await this.prisma.platformMetric.upsert({
          where: { metricType_date: { metricType, date: new Date(dateKey) } },
          update: { value },
          create: { metricType, date: new Date(dateKey), value },
        });
        count++;
      }
    }
    return count;
  }

  private async getRevenueRates() {
    const settings = await this.prisma.platformSetting.findMany({
      where: { key: { in: [SETTING_PROMOTED_RATE, SETTING_FEATURED_RATE] } },
    });
    const read = (key: string, fallback: number) => {
      const raw = settings.find((s) => s.key === key)?.value;
      const parsed = typeof raw === 'number' ? raw : Number(raw);
      return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
    };
    return {
      promoted: read(SETTING_PROMOTED_RATE, DEFAULT_PROMOTED_MONTHLY_UZS),
      featured: read(SETTING_FEATURED_RATE, DEFAULT_FEATURED_MONTHLY_UZS),
    };
  }

  // ============================================================================
  // 1. OVERVIEW CARDS
  // ============================================================================

  async getOverview() {
    const today = startOfToday();
    const onlineSince = new Date(Date.now() - ONLINE_WINDOW_MINUTES * 60_000);
    const rates = await this.getRevenueRates();

    const [
      totalUsers,
      businessesByStatus,
      totalReviews,
      totalEvents,
      onlineNow,
      todaySignups,
      todayBusinessSubmissions,
      todayReviews,
      pendingBusinesses,
      pendingReports,
      pendingClaims,
      pendingEvents,
      promoted,
      featured,
    ] = await Promise.all([
      this.prisma.user.count({ where: { deletedAt: null } }),
      this.prisma.business.groupBy({ by: ['status'], where: { deletedAt: null }, _count: true }),
      this.prisma.review.count({ where: { deletedAt: null } }),
      this.prisma.event.count({ where: { deletedAt: null } }),
      // No session store exists — lastLoginAt within the window is the closest
      // honest signal. It over-counts idle-but-recent logins.
      this.prisma.user.count({ where: { deletedAt: null, lastLoginAt: { gte: onlineSince } } }),
      this.prisma.user.count({ where: { deletedAt: null, createdAt: { gte: today } } }),
      this.prisma.business.count({ where: { deletedAt: null, createdAt: { gte: today } } }),
      this.prisma.review.count({ where: { deletedAt: null, createdAt: { gte: today } } }),
      this.prisma.business.count({ where: { deletedAt: null, status: BusinessStatus.PENDING } }),
      this.prisma.reviewReport.count({ where: { status: ReportStatus.PENDING } }),
      this.prisma.businessClaim.count({ where: { status: ClaimStatus.PENDING } }),
      this.prisma.event.count({ where: { deletedAt: null, status: EventStatus.PENDING } }),
      this.prisma.business.count({
        where: {
          deletedAt: null,
          isPromoted: true,
          OR: [{ promotedUntil: null }, { promotedUntil: { gte: new Date() } }],
        },
      }),
      this.prisma.business.count({
        where: {
          deletedAt: null,
          isFeatured: true,
          OR: [{ featuredUntil: null }, { featuredUntil: { gte: new Date() } }],
        },
      }),
    ]);

    const statusCounts = Object.fromEntries(Object.values(BusinessStatus).map((s) => [s, 0])) as Record<
      BusinessStatus,
      number
    >;
    for (const row of businessesByStatus) statusCounts[row.status] = row._count;

    return {
      totalUsers,
      totalBusinesses: {
        approved: statusCounts.APPROVED,
        pending: statusCounts.PENDING,
        rejected: statusCounts.REJECTED,
        draft: statusCounts.DRAFT,
        suspended: statusCounts.SUSPENDED,
      },
      totalReviews,
      totalEvents,
      onlineNow,
      todaySignups,
      todayBusinessSubmissions,
      todayReviews,
      pendingModeration: {
        businesses: pendingBusinesses,
        reviews: pendingReports,
        claims: pendingClaims,
        events: pendingEvents,
      },
      revenueEstimate: {
        promoted,
        featured,
        potentialMonthly: promoted * rates.promoted + featured * rates.featured,
        currency: 'UZS',
        rates: { promotedMonthly: rates.promoted, featuredMonthly: rates.featured },
        note: 'Estimate only — no payments module exists yet. Rates are configurable via PlatformSetting.',
      },
    };
  }

  // ============================================================================
  // 2. GROWTH CHARTS
  // ============================================================================

  async getGrowth(query: GrowthQueryDto) {
    const days = query.period === GrowthPeriod.NINETY_DAYS ? 90 : query.period === GrowthPeriod.THIRTY_DAYS ? 30 : 7;
    const end = dateOnly(new Date());
    const start = addDays(end, -(days - 1));

    const metricTypes = [METRIC.NEW_SIGNUPS, METRIC.NEW_BUSINESSES, METRIC.REVIEWS_POSTED, METRIC.SEARCH_QUERIES];

    const rows = await this.prisma.platformMetric.findMany({
      where: { metricType: { in: metricTypes }, date: { gte: start, lte: end } },
      orderBy: { date: 'asc' },
    });

    const byType = new Map<string, Map<string, number>>(metricTypes.map((t) => [t, new Map()]));
    for (const row of rows) {
      byType.get(row.metricType)?.set(isoDate(row.date), row.value);
    }

    const series = (metricType: string) => {
      const lookup = byType.get(metricType) ?? new Map();
      return Array.from({ length: days }, (_, i) => {
        const key = isoDate(addDays(start, i));
        return { date: key, value: lookup.get(key) ?? 0 };
      });
    };

    return {
      users: series(METRIC.NEW_SIGNUPS),
      businesses: series(METRIC.NEW_BUSINESSES),
      reviews: series(METRIC.REVIEWS_POSTED),
      searches: series(METRIC.SEARCH_QUERIES),
      note: 'Served from pre-aggregated PlatformMetric rows. Run POST /admin/analytics/aggregate to refresh.',
    };
  }

  // ============================================================================
  // 3. GEOGRAPHIC HEATMAP
  // ============================================================================

  async getGeography() {
    // User has no home district/city column, so "users" here means users who
    // have actually engaged in that district (left a review on a branch
    // there). It is a demand proxy, not a residency count.
    const [districtRows, cityRows] = await Promise.all([
      this.prisma.$queryRaw<{ id: number; name: string; businesses: number; users: number }[]>`
        SELECT d.id,
               d.name_uz AS name,
               (SELECT count(DISTINCT br.business_id) FROM branches br
                  JOIN businesses b ON b.id = br.business_id
                 WHERE br.district_id = d.id AND br.deleted_at IS NULL AND b.deleted_at IS NULL)::int AS businesses,
               (SELECT count(DISTINCT r.user_id) FROM reviews r
                  JOIN branches br2 ON br2.id = r.branch_id
                 WHERE br2.district_id = d.id AND r.deleted_at IS NULL)::int AS users
          FROM districts d
         ORDER BY d.sort_order`,
      this.prisma.$queryRaw<{ id: number; name: string; businesses: number; users: number }[]>`
        SELECT c.id,
               c.name_uz AS name,
               (SELECT count(DISTINCT br.business_id) FROM branches br
                  JOIN businesses b ON b.id = br.business_id
                 WHERE br.city_id = c.id AND br.deleted_at IS NULL AND b.deleted_at IS NULL)::int AS businesses,
               (SELECT count(DISTINCT r.user_id) FROM reviews r
                  JOIN branches br2 ON br2.id = r.branch_id
                 WHERE br2.city_id = c.id AND r.deleted_at IS NULL)::int AS users
          FROM cities c
         ORDER BY c.sort_order`,
    ]);

    // Density is relative to the busiest district rather than a fixed cutoff,
    // so the buckets stay meaningful as the platform grows.
    const maxBusinesses = Math.max(1, ...districtRows.map((d) => d.businesses));
    const densityOf = (n: number): 'high' | 'medium' | 'low' => {
      const ratio = n / maxBusinesses;
      if (ratio >= 0.6) return 'high';
      if (ratio >= 0.25) return 'medium';
      return 'low';
    };

    const districts = districtRows.map((d) => {
      const density = densityOf(d.businesses);
      return {
        name: d.name,
        businesses: d.businesses,
        users: d.users,
        density,
        // Demand with no supply: people are active here but nobody has listed.
        ...(density === 'low' && d.users > 0 ? { opportunity: true } : {}),
      };
    });

    return {
      districts,
      cityBreakdown: cityRows.map((c) => ({ name: c.name, businesses: c.businesses, users: c.users })),
      emptyDistricts: districtRows.filter((d) => d.businesses === 0).map((d) => d.name),
      note: '"users" counts users who reviewed a business in that district — User has no home-location column, so this is an engagement proxy.',
    };
  }

  // ============================================================================
  // 4. CATEGORY PERFORMANCE
  // ============================================================================

  async getCategories() {
    const now = new Date();
    const last30 = addDays(now, -30);
    const previous30 = addDays(now, -60);

    const [categories, grouped, ratings, recent, prior] = await Promise.all([
      this.prisma.category.findMany({
        where: { deletedAt: null },
        select: { id: true, nameUz: true },
        orderBy: { sortOrder: 'asc' },
      }),
      this.prisma.business.groupBy({
        by: ['categoryId'],
        where: { deletedAt: null, status: BusinessStatus.APPROVED },
        _count: true,
        _sum: { reviewCount: true },
      }),
      // Averaged over rated businesses ONLY. Including unrated ones (whose
      // ratingAvg is a placeholder 0) would drag a category's score toward
      // zero and fire a false "needs attention" flag.
      this.prisma.business.groupBy({
        by: ['categoryId'],
        where: { deletedAt: null, status: BusinessStatus.APPROVED, reviewCount: { gt: 0 } },
        _avg: { ratingAvg: true },
      }),
      this.prisma.business.groupBy({
        by: ['categoryId'],
        where: { deletedAt: null, createdAt: { gte: last30 } },
        _count: true,
      }),
      this.prisma.business.groupBy({
        by: ['categoryId'],
        where: { deletedAt: null, createdAt: { gte: previous30, lt: last30 } },
        _count: true,
      }),
    ]);

    const statsBy = new Map(grouped.map((g) => [g.categoryId, g]));
    const ratingBy = new Map(ratings.map((g) => [g.categoryId, g._avg.ratingAvg]));
    const recentBy = new Map(recent.map((g) => [g.categoryId, g._count]));
    const priorBy = new Map(prior.map((g) => [g.categoryId, g._count]));

    const result = categories.map((c) => {
      const stats = statsBy.get(c.id);
      const businesses = stats?._count ?? 0;
      const avgRating = Math.round(toNumber(ratingBy.get(c.id)) * 10) / 10;
      const reviews = stats?._sum.reviewCount ?? 0;
      const growth = pctChange(recentBy.get(c.id) ?? 0, priorBy.get(c.id) ?? 0);

      // Surfaced when a category has listings but they are underperforming, or
      // when it is shrinking — both are founder-actionable.
      const needsAttention = (businesses > 0 && avgRating > 0 && avgRating < 4) || growth.startsWith('-');

      return {
        name: c.nameUz,
        businesses,
        avgRating,
        reviews,
        growth,
        ...(needsAttention ? { flag: 'needs attention' } : {}),
      };
    });

    return { categories: result.sort((a, b) => b.businesses - a.businesses) };
  }

  // ============================================================================
  // 5. SEARCH INTELLIGENCE
  // ============================================================================

  async getSearchIntelligence() {
    const now = new Date();
    const last7 = addDays(now, -7);
    const previous7 = addDays(now, -14);

    const [topQueries, zeroResult, avgRow, recentRows, priorRows] = await Promise.all([
      this.prisma.$queryRaw<{ query: string; count: number }[]>`
        SELECT query, count(*)::int AS count FROM search_analytics
        GROUP BY query ORDER BY count DESC, query ASC LIMIT 20`,
      // The single most commercially useful signal here: demand the platform
      // cannot currently satisfy.
      this.prisma.$queryRaw<{ query: string; count: number }[]>`
        SELECT query, count(*)::int AS count FROM search_analytics
        WHERE result_count = 0
        GROUP BY query ORDER BY count DESC, query ASC LIMIT 20`,
      this.prisma.$queryRaw<{ avg: number | null }[]>`
        SELECT avg(result_count)::float AS avg FROM search_analytics`,
      this.prisma.$queryRaw<{ query: string; count: number }[]>`
        SELECT query, count(*)::int AS count FROM search_analytics
        WHERE created_at >= ${last7} GROUP BY query`,
      this.prisma.$queryRaw<{ query: string; count: number }[]>`
        SELECT query, count(*)::int AS count FROM search_analytics
        WHERE created_at >= ${previous7} AND created_at < ${last7} GROUP BY query`,
    ]);

    const priorBy = new Map(priorRows.map((r) => [r.query, r.count]));
    const trendingQueries = recentRows
      .map((r) => ({ query: r.query, count: r.count, change: pctChange(r.count, priorBy.get(r.query) ?? 0) }))
      .filter((r) => !r.change.startsWith('-') && r.change !== '0%')
      .sort((a, b) => b.count - a.count)
      .slice(0, 10);

    return {
      topQueries,
      zeroResultQueries: zeroResult,
      trendingQueries,
      avgResultsPerQuery: Math.round((avgRow[0]?.avg ?? 0) * 10) / 10,
    };
  }

  // ============================================================================
  // 6. USER QUALITY
  // ============================================================================

  async getUsers() {
    const churnCutoff = addDays(new Date(), -CHURN_RISK_DAYS);

    const [topReviewers, mostActiveOwners, flagged, churnRisk] = await Promise.all([
      this.prisma.$queryRaw<{ userId: number; name: string; reviewCount: number; helpfulCount: number }[]>`
        SELECT u.id AS "userId", u.full_name AS name,
               count(r.id)::int AS "reviewCount",
               coalesce(sum(r.helpful_count), 0)::int AS "helpfulCount"
          FROM users u JOIN reviews r ON r.user_id = u.id AND r.deleted_at IS NULL
         WHERE u.deleted_at IS NULL
         GROUP BY u.id, u.full_name
         ORDER BY "reviewCount" DESC, "helpfulCount" DESC
         LIMIT 10`,
      // replyRate = share of reviews on this owner's businesses that they
      // have actually replied to — the clearest single measure of an engaged
      // business owner.
      this.prisma.$queryRaw<{ userId: number; name: string; businessCount: number; reviews: number; replies: number }[]>`
        SELECT u.id AS "userId", u.full_name AS name,
               count(DISTINCT b.id)::int AS "businessCount",
               count(DISTINCT r.id)::int AS reviews,
               count(DISTINCT rr.id)::int AS replies
          FROM users u
          JOIN businesses b ON b.owner_id = u.id AND b.deleted_at IS NULL
          LEFT JOIN branches br ON br.business_id = b.id AND br.deleted_at IS NULL
          LEFT JOIN reviews r ON r.branch_id = br.id AND r.deleted_at IS NULL
          LEFT JOIN review_replies rr ON rr.review_id = r.id AND rr.deleted_at IS NULL
         WHERE u.deleted_at IS NULL
         GROUP BY u.id, u.full_name
         ORDER BY "businessCount" DESC, reviews DESC
         LIMIT 10`,
      this.prisma.$queryRaw<{ userId: number; name: string; rejected: number }[]>`
        SELECT u.id AS "userId", u.full_name AS name, count(b.id)::int AS rejected
          FROM users u JOIN businesses b ON b.owner_id = u.id AND b.status = 'REJECTED' AND b.deleted_at IS NULL
         WHERE u.deleted_at IS NULL
         GROUP BY u.id, u.full_name
        HAVING count(b.id) >= ${FLAG_REJECTED_BUSINESS_THRESHOLD}
         ORDER BY rejected DESC
         LIMIT 20`,
      this.prisma.user.findMany({
        where: {
          deletedAt: null,
          role: { in: [UserRole.BUSINESS_OWNER, UserRole.CUSTOMER] },
          OR: [{ lastLoginAt: { lt: churnCutoff } }, { lastLoginAt: null, createdAt: { lt: churnCutoff } }],
        },
        select: { id: true, fullName: true, lastLoginAt: true, createdAt: true },
        orderBy: { lastLoginAt: 'asc' },
        take: 20,
      }),
    ]);

    const daysAgo = (d: Date) => Math.floor((Date.now() - d.getTime()) / 86_400_000);

    return {
      topReviewers: topReviewers.map((r) => ({
        userId: r.userId,
        name: r.name,
        reviewCount: r.reviewCount,
        helpfulCount: r.helpfulCount,
      })),
      mostActiveOwners: mostActiveOwners.map((o) => ({
        userId: o.userId,
        name: o.name,
        businessCount: o.businessCount,
        replyRate: o.reviews === 0 ? 'n/a' : `${Math.round((o.replies / o.reviews) * 100)}%`,
      })),
      flaggedAccounts: flagged.map((f) => ({
        userId: f.userId,
        name: f.name,
        reason: `${f.rejected} rejected businesses`,
        status: 'watch',
      })),
      churnRisk: churnRisk.map((u) => ({
        userId: u.id,
        name: u.fullName,
        lastLogin: u.lastLoginAt ? `${daysAgo(u.lastLoginAt)} days ago` : 'never',
      })),
    };
  }

  // ============================================================================
  // 7. MODERATION PIPELINE
  // ============================================================================

  async getModeration() {
    const today = startOfToday();
    // Passed in as an explicit instant rather than using SQL now(): Prisma
    // stores timestamps in UTC, but now() resolves to the DATABASE server's
    // timezone (Asia/Tashkent here), which silently inflated every wait time
    // by the UTC offset.
    const nowUtc = new Date();

    const [businessQueue, reportQueue, pendingClaims, pendingEvents, actionsToday, responseTimes] = await Promise.all([
      this.prisma.$queryRaw<{ pending: number; avg_wait_ms: number | null; oldest: Date | null }[]>`
        SELECT count(*)::int AS pending,
               avg(EXTRACT(EPOCH FROM ((${nowUtc}::timestamptz AT TIME ZONE 'UTC') - created_at)) * 1000)::float AS avg_wait_ms,
               min(created_at) AS oldest
          FROM businesses WHERE status = 'PENDING' AND deleted_at IS NULL`,
      this.prisma.$queryRaw<{ pending: number; avg_wait_ms: number | null; oldest: Date | null }[]>`
        SELECT count(*)::int AS pending,
               avg(EXTRACT(EPOCH FROM ((${nowUtc}::timestamptz AT TIME ZONE 'UTC') - created_at)) * 1000)::float AS avg_wait_ms,
               min(created_at) AS oldest
          FROM review_reports WHERE status = 'PENDING'`,
      this.prisma.businessClaim.count({ where: { status: ClaimStatus.PENDING } }),
      this.prisma.event.count({ where: { status: EventStatus.PENDING, deletedAt: null } }),
      // Restricted to ADMIN actors: AuditLog also records non-admin
      // self-actions (e.g. the ROLE_CHANGE written when a customer creates
      // their first business), which are not moderation work.
      this.prisma.auditLog.groupBy({
        by: ['actorId'],
        where: { createdAt: { gte: today }, actor: { role: UserRole.ADMIN } },
        _count: true,
      }),
      // Response time = how long a business sat in the queue before an admin
      // acted on it. Joins audit entries back to the entity they targeted.
      this.prisma.$queryRaw<{ actorId: number; avg_ms: number | null }[]>`
        SELECT a.actor_id AS "actorId",
               avg(EXTRACT(EPOCH FROM (a.created_at - b.created_at)) * 1000)::float AS avg_ms
          FROM audit_logs a
          JOIN businesses b ON b.id = a.entity_id
         WHERE a.entity_type = 'Business' AND a.action IN ('APPROVE', 'REJECT') AND a.actor_id IS NOT NULL
         GROUP BY a.actor_id`,
    ]);

    const actorIds = [...new Set(actionsToday.map((a) => a.actorId).filter((id): id is number => id !== null))];
    const admins = actorIds.length
      ? await this.prisma.user.findMany({ where: { id: { in: actorIds } }, select: { id: true, fullName: true } })
      : [];
    const nameById = new Map(admins.map((a) => [a.id, a.fullName]));
    const responseById = new Map(responseTimes.map((r) => [r.actorId, r.avg_ms]));

    const b = businessQueue[0];
    const r = reportQueue[0];

    return {
      queue: {
        businesses: {
          pending: b?.pending ?? 0,
          avgWaitTime: humanizeDuration(b?.avg_wait_ms ?? 0),
          oldest: b?.oldest ? isoDate(new Date(b.oldest)) : null,
        },
        reviews: {
          reported: r?.pending ?? 0,
          avgWaitTime: humanizeDuration(r?.avg_wait_ms ?? 0),
          oldest: r?.oldest ? isoDate(new Date(r.oldest)) : null,
        },
        claims: { pending: pendingClaims },
        events: { pending: pendingEvents },
      },
      moderatorPerformance: actionsToday
        .filter((a) => a.actorId !== null)
        .map((a) => ({
          adminId: a.actorId as number,
          name: nameById.get(a.actorId as number) ?? null,
          actionsToday: a._count,
          avgResponseTime: humanizeDuration(responseById.get(a.actorId as number) ?? 0),
        }))
        .sort((x, y) => y.actionsToday - x.actionsToday),
    };
  }

  // ============================================================================
  // 8. BUSINESS HEALTH
  // ============================================================================

  async getBusinessHealth() {
    const [topRated, struggling, incompleteProfiles, neverClaimed] = await Promise.all([
      this.prisma.business.findMany({
        where: { deletedAt: null, status: BusinessStatus.APPROVED, reviewCount: { gt: 0 } },
        orderBy: [{ ratingAvg: 'desc' }, { reviewCount: 'desc' }],
        take: 10,
        select: { id: true, name: true, ratingAvg: true, reviewCount: true },
      }),
      this.prisma.business.findMany({
        where: { deletedAt: null, status: BusinessStatus.APPROVED, reviewCount: { gt: 0 }, ratingAvg: { lt: 3 } },
        orderBy: { ratingAvg: 'asc' },
        take: 10,
        select: {
          id: true,
          name: true,
          ratingAvg: true,
          reviewCount: true,
          description: true,
          branches: {
            where: { deletedAt: null },
            select: { _count: { select: { photos: true, hours: true, reviews: { where: { reply: null } } } } },
          },
        },
      }),
      // "Incomplete" = missing description, or no branch has any photo, or no
      // branch has opening hours. Counted in SQL, not by loading rows.
      this.prisma.business.count({
        where: {
          deletedAt: null,
          OR: [
            { description: null },
            { branches: { none: { photos: { some: {} } } } },
            { branches: { none: { hours: { some: {} } } } },
          ],
        },
      }),
      this.prisma.business.count({ where: { deletedAt: null, ownerId: null } }),
    ]);

    return {
      topRated: topRated.map((b) => ({
        id: b.id,
        name: b.name,
        rating: toNumber(b.ratingAvg),
        reviewCount: b.reviewCount,
      })),
      struggling: struggling.map((b) => {
        const photos = b.branches.reduce((s, br) => s + br._count.photos, 0);
        const hours = b.branches.reduce((s, br) => s + br._count.hours, 0);
        const unreplied = b.branches.reduce((s, br) => s + br._count.reviews, 0);
        const issues: string[] = [];
        if (!b.description) issues.push('no description');
        if (photos === 0) issues.push('no photos');
        if (hours === 0) issues.push('no hours');
        if (unreplied > 0) issues.push('no replies');
        return {
          id: b.id,
          name: b.name,
          rating: toNumber(b.ratingAvg),
          reviewCount: b.reviewCount,
          flag: issues.length ? issues.join(', ') : 'low rating',
        };
      }),
      incompleteProfiles,
      neverClaimed,
    };
  }
}
