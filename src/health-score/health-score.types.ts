// ============================================================================
// Facts collected for one business, and the scores derived from them.
//
// Kept separate from the service so the scoring maths is a pure function of
// this struct — no Prisma, no I/O. That is what makes the algorithm testable
// and lets one SQL round trip feed a whole-platform recalculation.
// ============================================================================

export interface BusinessFacts {
  businessId: number;

  // Profile
  hasCover: boolean;
  descriptionLength: number;
  hasTelegram: boolean;
  hasInstagram: boolean;
  branchCount: number;
  branchesWithPhone: number;
  branchesWithoutHours: number;
  branchesWithoutLandmark: number;
  photoCount: number;

  // Engagement
  reviewCount: number;
  avgRating: number;
  replyCount: number;
  favoriteCount: number;

  // Visibility
  isPromoted: boolean;
  isFeatured: boolean;
  isVerified: boolean;
  productCount: number;
  eventCount: number;

  // Response
  avgReplySeconds: number | null; // null when nothing has ever been replied to
}

export interface HealthScores {
  overallScore: number;
  profileScore: number;
  engagementScore: number;
  visibilityScore: number;
  responseScore: number;
}

// Raw shape returned by the fact-collection query. Postgres hands back bigint
// counts and numeric averages that the driver may widen, so every field is
// normalized through Number() before it reaches the scoring functions.
export interface FactRow {
  businessId: number;
  hasCover: boolean;
  descriptionLength: number;
  hasTelegram: boolean;
  hasInstagram: boolean;
  branchCount: number;
  branchesWithPhone: number;
  branchesWithoutHours: number;
  branchesWithoutLandmark: number;
  photoCount: number;
  reviewCount: number;
  avgRating: number | null;
  replyCount: number;
  favoriteCount: number;
  isPromoted: boolean;
  isFeatured: boolean;
  isVerified: boolean;
  productCount: number;
  eventCount: number;
  avgReplySeconds: number | null;
}
