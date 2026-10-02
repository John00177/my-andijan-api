import { UserRole } from '@prisma/client';

// Phase 15D (D-75). Every authorization decision for a protected route is a
// CAPABILITY, granted to roles by the explicit table below — never by rank.
// Role = the operational job; capability = an action that job may take;
// ownership (policies.ts) = whether this particular record is yours;
// governance (PLATFORM_OWNER) = a separate, NOT YET IMPLEMENTED plane.
//
// Each entry is a real security boundary taken from the routes that exist.
export const CAPABILITIES = [
  // ---- acting as a member of the public ------------------------------------
  'review.write', // write / edit / delete your own reviews
  'review.report', // report a review into the moderation queue
  'business.claim', // claim an unowned listing (becomes its owner on approval)
  // ---- operating businesses you own (ownership checked per record) ---------
  'business.create', // submit a new listing (you become its owner)
  'business.manage_own', // owner dashboard: your listings' profile, hours, branches, catalog, events, replies, analytics, health score
  // ---- moderation ----------------------------------------------------------
  'business.review', // moderation queue: list listings, approve / reject (never your own)
  'review.moderate', // list / hide / restore reviews (never yours or your business's)
  'report.resolve', // list / resolve review reports (never one involving you)
  // ---- operations ------------------------------------------------------------
  'business.operate', // verify / suspend / promote and their reversals (never your own)
  'business.edit_any', // edit another owner's listing through /admin, with a reason
  'business.hide', // hide / unhide a listing (destructive visibility switch)
  'business.delete', // soft-delete a listing
  'claim.review', // list / approve / reject ownership claims (never your own)
  'event.review', // list / approve / reject events (never your business's)
  'taxonomy.manage', // categories, districts, cities; admin platform settings view
  'user.pii.read', // other users' contact details (user list, listing owners, reporters)
  'user.status.manage', // suspend / reinstate accounts — WHICH accounts is user-status.policy.ts
  'audit.read', // the application audit log
  'analytics.platform', // platform statistics, command centre, recomputation jobs
  'analytics.users', // user-level platform analytics
] as const;

export type Capability = (typeof CAPABILITIES)[number];

const MEMBER: Capability[] = ['review.write', 'review.report'];
const OWNER: Capability[] = ['business.claim', 'business.create', 'business.manage_own'];
const MODERATION: Capability[] = ['business.review', 'review.moderate', 'report.resolve'];
const OPERATIONS: Capability[] = [
  'business.operate',
  'business.edit_any',
  'claim.review',
  'event.review',
  'taxonomy.manage',
  'user.pii.read',
  'user.status.manage',
  'audit.read',
  'analytics.platform',
];

// THE role → capability table. Written out per role: nothing is derived from
// another role, and no role is "above" another. Changing what a role may do
// means editing its own line here (role-capabilities.spec.ts pins every line).
//
// - SUPPORT holds no business-owner capability: it is not a business owner.
//   (Its future support-desk capabilities are a later phase.)
// - MODERATOR holds moderation only — no edit, operations, PII or analytics.
// - Platform staff (MODERATOR / ADMIN / SUPER_ADMIN) hold NO business-owner
//   capability (Phase 15D.2): staff authority is platform capabilities, not
//   ownership. They administer other owners' listings through /admin with
//   explicit capabilities such as `business.edit_any`; someone who also runs
//   a business does so from a BUSINESS_OWNER account. Business-scoped staff
//   (future) will be membership, not a role.
// - SUPER_ADMIN differs from ADMIN by three explicit capabilities, and holds
//   NO governance authority: governance is not a capability (see
//   @RequireGovernance, which denies everything until that plane exists).
export const ROLE_CAPABILITIES: Readonly<Record<UserRole, ReadonlySet<Capability>>> = {
  [UserRole.CUSTOMER]: new Set<Capability>([...MEMBER, 'business.claim']),
  [UserRole.BUSINESS_OWNER]: new Set<Capability>([...MEMBER, ...OWNER]),
  [UserRole.SUPPORT]: new Set<Capability>([...MEMBER]),
  [UserRole.MODERATOR]: new Set<Capability>([...MEMBER, ...MODERATION]),
  [UserRole.ADMIN]: new Set<Capability>([...MEMBER, ...MODERATION, ...OPERATIONS]),
  [UserRole.SUPER_ADMIN]: new Set<Capability>([
    ...MEMBER,
    ...MODERATION,
    ...OPERATIONS,
    'business.hide',
    'business.delete',
    'analytics.users',
  ]),
};

export function hasCapability(role: UserRole | undefined | null, capability: Capability): boolean {
  if (!role) return false;
  return ROLE_CAPABILITIES[role]?.has(capability) ?? false;
}

// Sorted, for GET /users/me and auth responses (the frontend renders from it;
// it is never trusted as authorization).
export function capabilitiesFor(role: UserRole): Capability[] {
  return CAPABILITIES.filter((capability) => ROLE_CAPABILITIES[role].has(capability));
}
