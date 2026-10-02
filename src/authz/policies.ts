import { ForbiddenException } from '@nestjs/common';

// Record-level authorization (Phase 15D, D-75). The route's capability says
// WHAT kind of action a role may take; these say whether THIS record allows
// it. Services call them after loading the record, inside the same
// transaction as the write. Pure functions — exhaustively unit-tested.

type Actor = { id: number };

/**
 * OWNERSHIP: the caller must own the business. Used by every owner route
 * (profile, hours, catalog, events, review replies). No role bypasses it —
 * staff edit someone else's business only through the /admin routes.
 */
export function assertOwnsBusiness(business: { ownerId: number | null }, actor: Actor, message?: string): void {
  if (business.ownerId === null || business.ownerId !== actor.id) {
    throw new ForbiddenException(message ?? 'You do not have permission to manage this business');
  }
}

/**
 * CONFLICT OF INTEREST: staff never moderate or operate on a listing they own
 * — approve/reject, verify, suspend, promote, hide, delete, and the /admin
 * edit routes (an owner edits their own listing through the owner routes).
 */
export function assertNotOwnBusiness(business: { ownerId: number | null }, actor: Actor): void {
  if (business.ownerId !== null && business.ownerId === actor.id) {
    throw new ForbiddenException('You cannot act on a business you own (conflict of interest)');
  }
}

/** Staff never decide their own ownership claim. */
export function assertNotOwnClaim(claim: { claimantId: number }, actor: Actor): void {
  if (claim.claimantId === actor.id) {
    throw new ForbiddenException('You cannot review your own claim (conflict of interest)');
  }
}

/**
 * Review moderation (hide/restore) is refused when the moderator wrote the
 * review or owns the reviewed business — either way they would be ruling on
 * their own interest.
 */
export function assertNotOwnReviewMatter(
  review: { userId: number; businessOwnerId: number | null },
  actor: Actor,
): void {
  if (review.userId === actor.id || (review.businessOwnerId !== null && review.businessOwnerId === actor.id)) {
    throw new ForbiddenException('You cannot moderate a review you wrote or one about your business (conflict of interest)');
  }
}

/** Report resolution: not if you filed it, wrote the review, or own the business. */
export function assertNotOwnReportMatter(
  report: { reporterId: number; reviewAuthorId: number; businessOwnerId: number | null },
  actor: Actor,
): void {
  if (
    report.reporterId === actor.id ||
    report.reviewAuthorId === actor.id ||
    (report.businessOwnerId !== null && report.businessOwnerId === actor.id)
  ) {
    throw new ForbiddenException('You cannot resolve a report that involves you (conflict of interest)');
  }
}
