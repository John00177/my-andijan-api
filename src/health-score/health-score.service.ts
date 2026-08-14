import { ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { BusinessStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { BusinessFacts, FactRow, HealthScores } from './health-score.types';
import { RECOMMENDATION_RULES, RecommendationRule } from './recommendation-catalog';
import { RECOMMENDATION_THRESHOLD, healthBand, scoreBusiness } from './scoring';

const MAX_RECOMMENDATIONS = 5;

// Order recommendations by urgency, then by how weak the category they came
// from is — so when two HIGH items compete, the one addressing the bigger hole
// is shown first.
const PRIORITY_RANK: Record<string, number> = { HIGH: 0, MEDIUM: 1, LOW: 2 };

type ScoreKey = 'profileScore' | 'engagementScore' | 'visibilityScore' | 'responseScore';

const TYPE_TO_SCORE: Record<string, ScoreKey> = {
  PROFILE: 'profileScore',
  ENGAGEMENT: 'engagementScore',
  VISIBILITY: 'visibilityScore',
  RESPONSE: 'responseScore',
};

@Injectable()
export class HealthScoreService {
  private readonly logger = new Logger(HealthScoreService.name);

  constructor(private readonly prisma: PrismaService) {}

  // ============================================================================
  // FACT COLLECTION
  //
  // One statement gathers every input the algorithm needs, for one business or
  // for all of them. Correlated subqueries rather than a pile of JOINs: each
  // counts an independent child table, and joining them all at once would
  // multiply rows together (three branches x four reviews x two photos) and
  // require DISTINCT gymnastics to undo.
  //
  // `now` is passed in as an explicit UTC instant rather than using SQL now():
  // Prisma stores timestamps in UTC but now() resolves in the DATABASE server's
  // timezone, which is Asia/Tashkent here — the same trap already documented in
  // CommandCenterService.getModeration().
  // ============================================================================

  // `client` must be the caller's transaction client when one is in play:
  // reading through this.prisma from inside someone else's interactive
  // transaction would not see their uncommitted writes, and the score would be
  // computed from pre-change data.
  private async collectFacts(
    businessId?: number,
    client: Prisma.TransactionClient = this.prisma,
  ): Promise<BusinessFacts[]> {
    const now = new Date();
    const scope = businessId
      ? Prisma.sql`AND b.id = ${businessId}`
      : Prisma.sql``;

    const rows = await client.$queryRaw<FactRow[]>`
      SELECT
        b.id AS "businessId",
        (b.cover_url IS NOT NULL AND b.cover_url <> '')  AS "hasCover",
        coalesce(length(b.description), 0)::int          AS "descriptionLength",
        (b.telegram  IS NOT NULL AND b.telegram  <> '')  AS "hasTelegram",
        (b.instagram IS NOT NULL AND b.instagram <> '')  AS "hasInstagram",
        b.is_verified                                    AS "isVerified",
        (b.is_promoted AND (b.promoted_until IS NULL OR b.promoted_until >= ${now})) AS "isPromoted",
        (b.is_featured AND (b.featured_until IS NULL OR b.featured_until >= ${now})) AS "isFeatured",

        (SELECT count(*)::int FROM branches br
          WHERE br.business_id = b.id AND br.deleted_at IS NULL) AS "branchCount",
        (SELECT count(*)::int FROM branches br
          WHERE br.business_id = b.id AND br.deleted_at IS NULL AND br.phone <> '') AS "branchesWithPhone",
        (SELECT count(*)::int FROM branches br
          WHERE br.business_id = b.id AND br.deleted_at IS NULL
            AND NOT EXISTS (SELECT 1 FROM branch_hours h WHERE h.branch_id = br.id)) AS "branchesWithoutHours",
        (SELECT count(*)::int FROM branches br
          WHERE br.business_id = b.id AND br.deleted_at IS NULL
            AND (br.landmark IS NULL OR br.landmark = '')) AS "branchesWithoutLandmark",
        (SELECT count(*)::int FROM branch_photos p
           JOIN branches br ON br.id = p.branch_id
          WHERE br.business_id = b.id AND br.deleted_at IS NULL) AS "photoCount",

        (SELECT count(*)::int FROM reviews r
           JOIN branches br ON br.id = r.branch_id
          WHERE br.business_id = b.id AND br.deleted_at IS NULL
            AND r.status = 'PUBLISHED' AND r.deleted_at IS NULL) AS "reviewCount",
        (SELECT avg(r.rating)::float FROM reviews r
           JOIN branches br ON br.id = r.branch_id
          WHERE br.business_id = b.id AND br.deleted_at IS NULL
            AND r.status = 'PUBLISHED' AND r.deleted_at IS NULL) AS "avgRating",
        (SELECT count(*)::int FROM review_replies rr
           JOIN reviews r  ON r.id  = rr.review_id
           JOIN branches br ON br.id = r.branch_id
          WHERE br.business_id = b.id AND br.deleted_at IS NULL
            AND r.status = 'PUBLISHED' AND r.deleted_at IS NULL
            AND rr.deleted_at IS NULL) AS "replyCount",
        (SELECT avg(EXTRACT(EPOCH FROM (rr.created_at - r.created_at)))::float FROM review_replies rr
           JOIN reviews r  ON r.id  = rr.review_id
           JOIN branches br ON br.id = r.branch_id
          WHERE br.business_id = b.id AND br.deleted_at IS NULL
            AND r.status = 'PUBLISHED' AND r.deleted_at IS NULL
            AND rr.deleted_at IS NULL) AS "avgReplySeconds",

        -- Counted from the source table rather than businesses.favorite_count:
        -- the denormalized column is maintained by FavoritesService, but a
        -- score that silently inherits any drift in it is not worth the saving.
        (SELECT count(*)::int FROM favorites fv
          WHERE fv.business_id = b.id) AS "favoriteCount",

        (SELECT count(*)::int FROM products p
          WHERE p.business_id = b.id AND p.deleted_at IS NULL AND p.is_active) AS "productCount",
        -- PUBLISHED only: a draft event is not visible to anyone, so it cannot
        -- be earning visibility points.
        (SELECT count(*)::int FROM events e
          WHERE e.business_id = b.id AND e.deleted_at IS NULL AND e.status = 'PUBLISHED') AS "eventCount"
      FROM businesses b
      WHERE b.deleted_at IS NULL ${scope}`;

    return rows.map((r) => ({
      businessId: Number(r.businessId),
      hasCover: r.hasCover,
      descriptionLength: Number(r.descriptionLength),
      hasTelegram: r.hasTelegram,
      hasInstagram: r.hasInstagram,
      branchCount: Number(r.branchCount),
      branchesWithPhone: Number(r.branchesWithPhone),
      branchesWithoutHours: Number(r.branchesWithoutHours),
      branchesWithoutLandmark: Number(r.branchesWithoutLandmark),
      photoCount: Number(r.photoCount),
      reviewCount: Number(r.reviewCount),
      avgRating: r.avgRating === null ? 0 : Number(r.avgRating),
      replyCount: Number(r.replyCount),
      favoriteCount: Number(r.favoriteCount),
      isPromoted: r.isPromoted,
      isFeatured: r.isFeatured,
      isVerified: r.isVerified,
      productCount: Number(r.productCount),
      eventCount: Number(r.eventCount),
      avgReplySeconds: r.avgReplySeconds === null ? null : Number(r.avgReplySeconds),
    }));
  }

  // ============================================================================
  // RECOMMENDATION SELECTION
  //
  // A category scoring below the threshold opens the gate; the rule's own
  // `detect` predicate decides whether that specific gap is real. Both must
  // hold — which is why a business with a weak profile but an existing cover
  // photo is never told to add one.
  // ============================================================================

  private selectRecommendations(facts: BusinessFacts, scores: HealthScores): RecommendationRule[] {
    return RECOMMENDATION_RULES.filter((rule) => {
      const categoryScore = scores[TYPE_TO_SCORE[rule.type]];
      return categoryScore < RECOMMENDATION_THRESHOLD && rule.detect(facts);
    })
      .sort((a, b) => {
        const byPriority = PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority];
        if (byPriority !== 0) return byPriority;
        // Tie-break on the weaker category — the bigger hole goes first.
        return scores[TYPE_TO_SCORE[a.type]] - scores[TYPE_TO_SCORE[b.type]];
      })
      .slice(0, MAX_RECOMMENDATIONS);
  }

  // ============================================================================
  // RECALCULATION
  // ============================================================================

  // Recalculates one business. Accepts a transaction client so callers already
  // inside a transaction (admin review moderation, for instance) fold this into
  // their own commit rather than writing a score that survives their rollback.
  async recalculate(businessId: number, tx: Prisma.TransactionClient = this.prisma): Promise<HealthScores | null> {
    const [facts] = await this.collectFacts(businessId, tx);
    // Deleted or non-existent — nothing to score. Not an error: this runs from
    // write hooks that should never fail a user's request.
    if (!facts) return null;

    const scores = scoreBusiness(facts);
    const chosen = this.selectRecommendations(facts, scores);
    await this.persist(tx, facts.businessId, scores, chosen);
    return scores;
  }

  // Fire-and-forget wrapper for write hooks. A failure to update a derived
  // score must never turn a successful review or profile edit into a 500, so
  // this logs and swallows. The next write — or the admin recalculate
  // endpoint — repairs the row.
  async recalculateSafely(businessId: number): Promise<void> {
    try {
      await this.recalculate(businessId);
    } catch (error) {
      this.logger.error(`Health score recalculation failed for business ${businessId}`, error as Error);
    }
  }

  // Same, for a branch-scoped hook where the caller knows the branch but not
  // the business.
  async recalculateForBranchSafely(branchId: number): Promise<void> {
    try {
      const branch = await this.prisma.branch.findUnique({
        where: { id: branchId },
        select: { businessId: true },
      });
      if (branch) await this.recalculate(branch.businessId);
    } catch (error) {
      this.logger.error(`Health score recalculation failed for branch ${branchId}`, error as Error);
    }
  }

  private async persist(
    tx: Prisma.TransactionClient,
    businessId: number,
    scores: HealthScores,
    chosen: RecommendationRule[],
  ) {
    const healthScore = await tx.businessHealthScore.upsert({
      where: { businessId },
      update: scores,
      create: { businessId, ...scores },
    });

    const keep = new Set(chosen.map((r) => r.code));

    // Gaps that closed (or dropped out of the top 5) lose their row. Doing this
    // by code rather than deleting everything and re-inserting is what
    // preserves isCompleted on the rows that survive.
    await tx.businessRecommendation.deleteMany({
      where: { healthScoreId: healthScore.id, code: { notIn: [...keep] } },
    });

    for (const rule of chosen) {
      const payload = {
        type: rule.type,
        priority: rule.priority,
        titleUz: rule.titleUz,
        titleRu: rule.titleRu,
        titleEn: rule.titleEn,
        descriptionUz: rule.descriptionUz,
        descriptionRu: rule.descriptionRu,
        descriptionEn: rule.descriptionEn,
        actionTextUz: rule.actionTextUz,
        actionTextRu: rule.actionTextRu,
        actionTextEn: rule.actionTextEn,
        actionUrl: rule.actionUrl?.replace(':id', String(businessId)) ?? null,
        impactUz: rule.impactUz,
        impactRu: rule.impactRu,
        impactEn: rule.impactEn,
      };

      // `update` refreshes display copy but deliberately never touches
      // isCompleted/completedAt — the owner owns those, not the engine.
      await tx.businessRecommendation.upsert({
        where: { healthScoreId_code: { healthScoreId: healthScore.id, code: rule.code } },
        update: payload,
        create: { healthScoreId: healthScore.id, code: rule.code, ...payload },
      });
    }
  }

  // Whole-platform rebuild (POST /admin/health-scores/recalculate). Facts for
  // every business come back in a single query; only the writes are per-row.
  async recalculateAll() {
    const started = Date.now();
    const allFacts = await this.collectFacts();

    let recommendationsWritten = 0;
    for (const facts of allFacts) {
      const scores = scoreBusiness(facts);
      const chosen = this.selectRecommendations(facts, scores);
      await this.persist(this.prisma, facts.businessId, scores, chosen);
      recommendationsWritten += chosen.length;
    }

    return {
      businessesProcessed: allFacts.length,
      recommendationsWritten,
      durationMs: Date.now() - started,
    };
  }

  // ============================================================================
  // OWNER VIEW  (GET /me/health-score)
  // ============================================================================

  async getForOwner(userId: number, businessId?: number) {
    const business = businessId
      ? await this.prisma.business.findFirst({
          where: { id: businessId, ownerId: userId, deletedAt: null },
          select: { id: true, name: true, slug: true },
        })
      : await this.prisma.business.findFirst({
          where: { ownerId: userId, deletedAt: null },
          orderBy: { createdAt: 'asc' },
          select: { id: true, name: true, slug: true },
        });

    if (!business) {
      throw new NotFoundException(
        businessId ? `Business ${businessId} not found` : 'You do not have a business yet',
      );
    }

    // Computed on demand when missing, so an owner who opens the dashboard
    // before any write hook has fired still sees a real score rather than an
    // empty state.
    let score = await this.prisma.businessHealthScore.findUnique({
      where: { businessId: business.id },
      include: { recommendations: true },
    });

    if (!score) {
      await this.recalculate(business.id);
      score = await this.prisma.businessHealthScore.findUnique({
        where: { businessId: business.id },
        include: { recommendations: true },
      });
    }

    const recommendations = (score?.recommendations ?? [])
      .slice()
      .sort((a, b) => PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority]);

    return {
      business,
      overallScore: score?.overallScore ?? 0,
      band: healthBand(score?.overallScore ?? 0),
      breakdown: {
        profile: score?.profileScore ?? 0,
        engagement: score?.engagementScore ?? 0,
        visibility: score?.visibilityScore ?? 0,
        response: score?.responseScore ?? 0,
      },
      lastCalculatedAt: score?.lastCalculatedAt ?? null,
      recommendations,
      completedCount: recommendations.filter((r) => r.isCompleted).length,
    };
  }

  // POST /me/health-score/recommendations/:id/complete
  async completeRecommendation(userId: number, recommendationId: number) {
    const recommendation = await this.prisma.businessRecommendation.findUnique({
      where: { id: recommendationId },
      include: { healthScore: { include: { business: { select: { id: true, ownerId: true } } } } },
    });

    if (!recommendation) {
      throw new NotFoundException(`Recommendation ${recommendationId} not found`);
    }
    if (recommendation.healthScore.business.ownerId !== userId) {
      throw new ForbiddenException('You can only complete recommendations for your own business');
    }
    if (recommendation.isCompleted) {
      return recommendation;
    }

    const updated = await this.prisma.businessRecommendation.update({
      where: { id: recommendationId },
      data: { isCompleted: true, completedAt: new Date() },
    });

    // Marking it done is a claim, not proof. Recalculating immediately means
    // an owner who actually did the work sees the score move now, and one who
    // only ticked the box keeps the row (the gap is still detected).
    await this.recalculateSafely(recommendation.healthScore.business.id);

    return updated;
  }

  // ============================================================================
  // PLATFORM OVERVIEW  (GET /admin/command-center/health-overview)
  //
  // Restricted to APPROVED businesses: drafts and rejected listings would drag
  // the platform average down without representing anything the founder can act
  // on.
  // ============================================================================

  async getHealthOverview() {
    const scopedBusiness = { deletedAt: null, status: BusinessStatus.APPROVED };

    const [agg, scores, topRecommendations, unscored] = await Promise.all([
      this.prisma.businessHealthScore.aggregate({
        where: { business: scopedBusiness },
        _avg: { overallScore: true },
        _count: true,
      }),
      this.prisma.businessHealthScore.findMany({
        where: { business: scopedBusiness },
        select: { overallScore: true },
      }),
      this.prisma.businessRecommendation.groupBy({
        by: ['code', 'titleEn', 'titleUz', 'titleRu', 'priority'],
        where: { isCompleted: false, healthScore: { business: scopedBusiness } },
        _count: { code: true },
        orderBy: { _count: { code: 'desc' } },
        take: 5,
      }),
      this.prisma.business.count({ where: { ...scopedBusiness, healthScore: { is: null } } }),
    ]);

    const distribution = { excellent: 0, good: 0, average: 0, poor: 0 };
    for (const s of scores) distribution[healthBand(s.overallScore)]++;

    return {
      avgBusinessScore: Math.round(agg._avg.overallScore ?? 0),
      businessesScored: agg._count,
      // "Needs attention" is the poor band — these are the accounts worth a
      // human reaching out to.
      businessesNeedingAttention: distribution.poor,
      topRecommendations: topRecommendations.map((r) => ({
        code: r.code,
        titleEn: r.titleEn,
        titleUz: r.titleUz,
        titleRu: r.titleRu,
        priority: r.priority,
        businessCount: r._count.code,
      })),
      healthDistribution: distribution,
      // Non-zero means scores are stale for those businesses — they have never
      // been written to since the feature shipped. POST
      // /admin/health-scores/recalculate clears this.
      unscoredBusinesses: unscored,
      bands: { excellent: '80-100', good: '60-79', average: '40-59', poor: '0-39' },
    };
  }
}
