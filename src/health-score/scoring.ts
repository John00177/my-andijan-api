import { BusinessFacts, HealthScores } from './health-score.types';

// ============================================================================
// SCORING
//
// Pure functions: facts in, numbers out. No Prisma, no dates, no I/O — so the
// whole algorithm can be reasoned about (and unit tested) without a database.
//
// Two conventions used throughout:
//   * Bucket thresholds are expressed as ">=" ladders read top-down. The spec
//     wrote them as ranges ("31-50=80, 50+=100") which both overlap at the
//     boundary and leave float gaps (what is 3.95, or 4.45?). A descending
//     ">=" ladder is the same intent with every value assigned exactly once.
//   * "All branches have X" checks require at least one branch. A business
//     with zero branches would otherwise score full marks on those criteria
//     vacuously, which is exactly backwards.
// ============================================================================

// Weights for overallScore. The spec fixed the four sub-scores but left the
// blend unspecified. Profile and engagement carry more weight because they are
// the two the owner can move on their own; visibility is deliberately lighter
// since 50 of its 100 points (promoted + featured) are bought rather than
// earned, and a paid placement should not paper over a bad profile.
const OVERALL_WEIGHTS = {
  profile: 0.3,
  engagement: 0.3,
  visibility: 0.2,
  response: 0.2,
} as const;

// A sub-score at or above this is considered healthy; below it the
// recommendation engine opens that category.
export const RECOMMENDATION_THRESHOLD = 60;

// Component weights inside engagementScore, per spec.
const ENGAGEMENT_WEIGHTS = {
  reviews: 0.3,
  rating: 0.25,
  replyRate: 0.25,
  favorites: 0.2,
} as const;

// Higher is better: first step whose threshold the value reaches.
function ladder(value: number, steps: [number, number][]): number {
  for (const [threshold, score] of steps) {
    if (value >= threshold) return score;
  }
  return 0;
}

// Lower is better (used for elapsed time): first step the value stays under.
function ladderDesc(value: number, steps: [number, number][]): number {
  for (const [limit, score] of steps) {
    if (value < limit) return score;
  }
  return 0;
}

// ---- PROFILE (0-100) ----------------------------------------------------------
// Additive checklist. The eight weights below sum to exactly 100.
export function profileScore(f: BusinessFacts): number {
  let score = 0;
  if (f.hasCover) score += 15;
  if (f.photoCount >= 3) score += 15;
  if (f.descriptionLength > 200) score += 15;
  // Business has no phone column and Branch.phone is NOT NULL, so "has phone"
  // can only mean "has at least one branch reachable by phone". It therefore
  // scores 0 exactly when a business has no branches at all.
  if (f.branchesWithPhone > 0) score += 10;
  if (f.hasTelegram) score += 10;
  if (f.hasInstagram) score += 10;
  if (f.branchCount > 0 && f.branchesWithoutHours === 0) score += 15;
  if (f.branchCount > 0 && f.branchesWithoutLandmark === 0) score += 10;
  return score;
}

// ---- ENGAGEMENT (0-100) -------------------------------------------------------
// Weighted blend of four independently-bucketed signals.
export function engagementScore(f: BusinessFacts): number {
  const reviews = ladder(f.reviewCount, [
    [51, 100],
    [31, 80],
    [16, 60],
    [6, 40],
    [1, 20],
  ]);

  // Note this is 0 for an unrated business, which is intentional: the reviews
  // component above already rewards having any reviews at all, so a brand-new
  // business is not double-counted as "badly rated".
  const rating = ladder(f.avgRating, [
    [4.8, 100],
    [4.5, 75],
    [4.0, 50],
    [3.0, 25],
  ]);

  const replyRatePct = f.reviewCount === 0 ? 0 : (f.replyCount / f.reviewCount) * 100;
  const replyRate = ladder(replyRatePct, [
    [76, 100],
    [51, 75],
    [26, 50],
    [1, 25],
  ]);

  const favorites = ladder(f.favoriteCount, [
    [51, 100],
    [26, 75],
    [11, 50],
    [1, 25],
  ]);

  return Math.round(
    reviews * ENGAGEMENT_WEIGHTS.reviews +
      rating * ENGAGEMENT_WEIGHTS.rating +
      replyRate * ENGAGEMENT_WEIGHTS.replyRate +
      favorites * ENGAGEMENT_WEIGHTS.favorites,
  );
}

// ---- VISIBILITY (0-100) -------------------------------------------------------
// Additive; the five weights sum to exactly 100. isPromoted/isFeatured are
// evaluated against their expiry dates by the fact query, so a lapsed
// promotion stops counting the day it ends.
export function visibilityScore(f: BusinessFacts): number {
  let score = 0;
  if (f.isPromoted) score += 30;
  if (f.isFeatured) score += 20;
  if (f.isVerified) score += 20;
  if (f.productCount > 0) score += 15;
  if (f.eventCount > 0) score += 15;
  return score;
}

// ---- RESPONSE (0-100) ---------------------------------------------------------
// Speed and coverage, evenly weighted. The spec listed both components but no
// split; 50/50 is used because either one alone is gameable (instant replies to
// one review out of forty, or forty slow replies).
export function responseScore(f: BusinessFacts): number {
  // Nothing to answer yet. Scoring this 0 would both drag down a new business's
  // overall score and generate a "reply faster" instruction for someone with no
  // reviews — so an empty queue counts as answered. `detect` predicates in the
  // catalog independently require reviewCount > 0 before suggesting anything.
  if (f.reviewCount === 0) return 100;

  const speed =
    f.avgReplySeconds === null
      ? 0
      : ladderDesc(f.avgReplySeconds, [
          [3600, 100], // under 1h
          [6 * 3600, 80], // under 6h
          [24 * 3600, 60], // under 24h
          [3 * 86400, 40], // under 3d
          [7 * 86400, 20], // under 7d
        ]);

  const replyRatePct = (f.replyCount / f.reviewCount) * 100;
  const coverage = ladder(replyRatePct, [
    [76, 100],
    [51, 75],
    [26, 50],
    [1, 25],
  ]);

  return Math.round(speed * 0.5 + coverage * 0.5);
}

export function scoreBusiness(f: BusinessFacts): HealthScores {
  const profile = profileScore(f);
  const engagement = engagementScore(f);
  const visibility = visibilityScore(f);
  const response = responseScore(f);

  const overall = Math.round(
    profile * OVERALL_WEIGHTS.profile +
      engagement * OVERALL_WEIGHTS.engagement +
      visibility * OVERALL_WEIGHTS.visibility +
      response * OVERALL_WEIGHTS.response,
  );

  return {
    overallScore: overall,
    profileScore: profile,
    engagementScore: engagement,
    visibilityScore: visibility,
    responseScore: response,
  };
}

// Bands used by the founder-facing health overview.
export function healthBand(overall: number): 'excellent' | 'good' | 'average' | 'poor' {
  if (overall >= 80) return 'excellent';
  if (overall >= 60) return 'good';
  if (overall >= 40) return 'average';
  return 'poor';
}
