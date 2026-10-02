import { ForbiddenException } from '@nestjs/common';
import {
  assertNotOwnBusiness,
  assertNotOwnClaim,
  assertNotOwnReportMatter,
  assertNotOwnReviewMatter,
  assertOwnsBusiness,
} from './policies';

// Record-level policies (Phase 15D, D-75): ownership and conflict of interest.
const ME = { id: 7 };

describe('assertOwnsBusiness (ownership)', () => {
  it('allows the owner', () => expect(() => assertOwnsBusiness({ ownerId: 7 }, ME)).not.toThrow());
  it('refuses anyone else', () => expect(() => assertOwnsBusiness({ ownerId: 8 }, ME)).toThrow(ForbiddenException));
  it('refuses everyone on an unclaimed business', () =>
    expect(() => assertOwnsBusiness({ ownerId: null }, ME)).toThrow(ForbiddenException));
  it('carries a custom message', () => expect(() => assertOwnsBusiness({ ownerId: 8 }, ME, 'nope')).toThrow('nope'));
});

describe('assertNotOwnBusiness (conflict of interest)', () => {
  it('refuses acting on your own listing', () =>
    expect(() => assertNotOwnBusiness({ ownerId: 7 }, ME)).toThrow(ForbiddenException));
  it("allows another owner's listing", () => expect(() => assertNotOwnBusiness({ ownerId: 8 }, ME)).not.toThrow());
  it('allows an unclaimed listing', () => expect(() => assertNotOwnBusiness({ ownerId: null }, ME)).not.toThrow());
});

describe('assertNotOwnClaim', () => {
  it('refuses deciding your own claim', () =>
    expect(() => assertNotOwnClaim({ claimantId: 7 }, ME)).toThrow(ForbiddenException));
  it("allows someone else's claim", () => expect(() => assertNotOwnClaim({ claimantId: 8 }, ME)).not.toThrow());
});

describe('assertNotOwnReviewMatter', () => {
  it('refuses your own review', () =>
    expect(() => assertNotOwnReviewMatter({ userId: 7, businessOwnerId: 9 }, ME)).toThrow(ForbiddenException));
  it('refuses a review about your business', () =>
    expect(() => assertNotOwnReviewMatter({ userId: 9, businessOwnerId: 7 }, ME)).toThrow(ForbiddenException));
  it('allows an unrelated review', () =>
    expect(() => assertNotOwnReviewMatter({ userId: 9, businessOwnerId: 10 }, ME)).not.toThrow());
  it('allows a review of an unclaimed business', () =>
    expect(() => assertNotOwnReviewMatter({ userId: 9, businessOwnerId: null }, ME)).not.toThrow());
});

describe('assertNotOwnReportMatter', () => {
  const base = { reporterId: 1, reviewAuthorId: 2, businessOwnerId: 3 };
  it('allows an unrelated report', () => expect(() => assertNotOwnReportMatter(base, ME)).not.toThrow());
  it.each([
    ['you filed it', { ...base, reporterId: 7 }],
    ['you wrote the review', { ...base, reviewAuthorId: 7 }],
    ['it is about your business', { ...base, businessOwnerId: 7 }],
  ])('refuses a report when %s', (_why, report) => {
    expect(() => assertNotOwnReportMatter(report, ME)).toThrow(ForbiddenException);
  });
});
