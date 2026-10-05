import { UserRole } from '@prisma/client';
import { routeInventory } from './route-inventory';
import { decide } from './decide';

// Phase 15D backward-compatibility record (D-75). For EVERY route × role this
// compares the decision under the retired rank model (Phase 15B, commit
// fda2390, frozen below as data) with the decision under the capability
// model, and requires that every difference is one of the documented,
// intended changes listed at the bottom. An unexplained change fails CI.
//
// The legacy rank table lives ONLY here, as historical test data.
const LEGACY_RANK: Record<UserRole, number> = {
  CUSTOMER: 1,
  BUSINESS_OWNER: 2,
  SUPPORT: 3,
  MODERATOR: 4,
  ADMIN: 5,
  SUPER_ADMIN: 6,
};

type Legacy = 'public' | 'auth' | UserRole; // a UserRole value = rank floor

// Route-level rules at fda2390 (class-level @Roles(ADMIN) on AdminController
// and CommandCenterController; method overrides as listed).
const LEGACY: Record<string, Legacy> = {
  'GET /admin/stats': 'ADMIN',
  'GET /admin/businesses': 'MODERATOR',
  'POST /admin/businesses/:id/approve': 'MODERATOR',
  'POST /admin/businesses/:id/reject': 'MODERATOR',
  'PATCH /admin/businesses/:id/hide': 'SUPER_ADMIN',
  'PATCH /admin/businesses/:id/unhide': 'SUPER_ADMIN',
  'PATCH /admin/businesses/:id': 'ADMIN',
  'PUT /admin/businesses/:id/hours': 'ADMIN',
  'PATCH /admin/businesses/:id/branch': 'ADMIN',
  'POST /admin/businesses/:id/verify': 'ADMIN',
  'POST /admin/businesses/:id/unverify': 'ADMIN',
  'POST /admin/businesses/:id/suspend': 'ADMIN',
  'POST /admin/businesses/:id/unsuspend': 'ADMIN',
  'POST /admin/businesses/:id/promote': 'ADMIN',
  'POST /admin/businesses/:id/unpromote': 'ADMIN',
  'GET /admin/claims': 'ADMIN',
  'POST /admin/claims/:id/approve': 'ADMIN',
  'POST /admin/claims/:id/reject': 'ADMIN',
  'GET /admin/reports': 'MODERATOR',
  'POST /admin/reports/:id/resolve': 'MODERATOR',
  'GET /admin/reviews': 'MODERATOR',
  'POST /admin/reviews/:id/hide': 'MODERATOR',
  'POST /admin/reviews/:id/restore': 'MODERATOR',
  'GET /admin/events': 'ADMIN',
  'POST /admin/events/:id/approve': 'ADMIN',
  'POST /admin/events/:id/reject': 'ADMIN',
  'GET /admin/categories': 'ADMIN',
  'POST /admin/categories': 'ADMIN',
  'PATCH /admin/categories/reorder': 'ADMIN',
  'PATCH /admin/categories/:id': 'ADMIN',
  'DELETE /admin/categories/:id': 'ADMIN',
  'PATCH /admin/districts/:id': 'ADMIN',
  'PATCH /admin/cities/:id': 'ADMIN',
  'GET /admin/users': 'ADMIN',
  'POST /admin/users/:id/suspend': 'ADMIN',
  'POST /admin/users/:id/activate': 'ADMIN',
  'GET /admin/audit': 'ADMIN',
  'POST /analytics/view': 'public',
  'POST /analytics/click': 'public',
  'POST /analytics/search': 'public',
  'GET /me/analytics/overview': 'auth',
  'GET /me/analytics/traffic': 'auth',
  'GET /me/analytics/demographics': 'auth',
  'GET /me/analytics/search-terms': 'auth',
  'GET /me/analytics/peak-hours': 'auth',
  'GET /me/analytics/competitors': 'auth',
  'GET /admin/analytics/users': 'SUPER_ADMIN',
  'GET /admin/analytics/dashboard': 'SUPER_ADMIN',
  'POST /auth/register': 'public',
  'POST /auth/login': 'public',
  'POST /auth/refresh': 'public',
  'POST /auth/logout': 'auth',
  'POST /auth/otp/request': 'public',
  'POST /auth/otp/verify': 'public',
  'PUT /auth/profile': 'auth',
  'POST /auth/forgot-password': 'public',
  'POST /auth/verify-reset-code': 'public',
  'POST /auth/reset-password': 'public',
  'POST /businesses': 'CUSTOMER',
  'DELETE /businesses/:id': 'SUPER_ADMIN',
  'PATCH /businesses/:id': 'auth',
  'PUT /businesses/:id/hours': 'auth',
  'GET /businesses/featured': 'public',
  'GET /businesses/promoted': 'public',
  'GET /businesses': 'public',
  'GET /businesses/:id': 'public',
  'GET /businesses/:id/reviews': 'public',
  'POST /businesses/:id/reviews': 'CUSTOMER',
  'GET /categories/homepage': 'public',
  'GET /categories': 'public',
  'GET /categories/:slug': 'public',
  'POST /admin/analytics/aggregate': 'ADMIN',
  'GET /admin/command-center/overview': 'ADMIN',
  'GET /admin/command-center/growth': 'ADMIN',
  'GET /admin/command-center/geography': 'ADMIN',
  'GET /admin/command-center/categories': 'ADMIN',
  'GET /admin/command-center/search-intelligence': 'ADMIN',
  'GET /admin/command-center/users': 'ADMIN',
  'GET /admin/command-center/moderation': 'ADMIN',
  'GET /admin/command-center/business-health': 'ADMIN',
  'GET /admin/command-center/health-overview': 'ADMIN',
  'GET /events': 'public',
  'POST /events': 'auth',
  'GET /events/:slug': 'public',
  'POST /events/:slug/attend': 'auth',
  'POST /favorites': 'auth',
  'DELETE /favorites/:businessId': 'auth',
  'GET /favorites': 'auth',
  'GET /geography/regions': 'public',
  'GET /geography/districts': 'public',
  'GET /geography/districts/:id/cities': 'public',
  'GET /geography/cities': 'public',
  'GET /geography/cities/:id': 'public',
  'GET /me/health-score': 'auth',
  'POST /me/health-score/recommendations/:id/complete': 'auth',
  'POST /admin/health-scores/recalculate': 'ADMIN',
  'GET /me/stats': 'auth',
  'GET /me/businesses': 'auth',
  'POST /me/businesses': 'auth',
  'GET /me/businesses/:id': 'auth',
  'PATCH /me/businesses/:id': 'auth',
  'POST /me/businesses/:id/branches': 'auth',
  'PATCH /me/branches/:id': 'auth',
  'GET /me/reviews': 'auth',
  'POST /me/reviews/:id/reply': 'auth',
  'GET /me/events': 'auth',
  'POST /me/events': 'auth',
  'PATCH /me/events/:id': 'auth',
  'DELETE /me/events/:id': 'auth',
  'GET /me/claims': 'auth',
  'POST /me/claims': 'auth',
  'GET /businesses/:id/menu': 'public',
  'POST /businesses/:id/menu': 'auth',
  'GET /me/businesses/:id/menu': 'auth',
  'PATCH /menu/:id': 'auth',
  'DELETE /menu/:id': 'auth',
  'POST /reviews': 'auth',
  'GET /reviews/:id': 'public',
  'PATCH /reviews/:id': 'auth',
  'DELETE /reviews/:id': 'auth',
  'POST /reviews/:id/report': 'auth',
  'POST /reviews/:id/reply': 'auth',
  'PATCH /reviews/:id/reply': 'auth',
  'GET /search': 'public',
  'POST /upload/image': 'auth',
  'GET /users/me': 'auth',
  'PATCH /users/me': 'auth',
  // ---- Added AFTER fda2390 — these routes did not exist under the rank model.
  // Each is recorded at the rank floor of the route group it joins, so this
  // comparison still proves the new route is no wider than its siblings.
  // Phase 16E: the review drawer's listing detail, joining the MODERATOR
  // business queue (GET /admin/businesses, approve, reject).
  'GET /admin/businesses/:id': 'MODERATOR',
};

function legacyDecision(rule: Legacy, role: UserRole | null): 'allow' | 'unauthenticated' | 'forbidden' {
  if (rule === 'public') return 'allow';
  if (role === null) return 'unauthenticated';
  if (rule === 'auth') return 'allow';
  return LEGACY_RANK[role] >= LEGACY_RANK[rule] ? 'allow' : 'forbidden';
}

// THE intended changes, listed route by route. Owner capabilities belong to
// BUSINESS_OWNER only; CUSTOMER keeps claiming. Under the rank model these
// routes were open to any signed-in account, the service then checking
// ownership. Now SUPPORT and every platform staff role (MODERATOR, and since
// Phase 15D.2 ADMIN and SUPER_ADMIN) — and, for operating or creating
// listings, CUSTOMER — are refused at the route. Staff administer other
// owners' listings through /admin (`business.edit_any` etc.), unchanged.
const OWNER_ROUTES = [
  'POST /businesses',
  'PATCH /businesses/:id',
  'PUT /businesses/:id/hours',
  'POST /businesses/:id/menu',
  'GET /me/businesses/:id/menu',
  'PATCH /menu/:id',
  'DELETE /menu/:id',
  'POST /events',
  'POST /reviews/:id/reply',
  'PATCH /reviews/:id/reply',
  'GET /me/stats',
  'GET /me/businesses',
  'POST /me/businesses',
  'GET /me/businesses/:id',
  'PATCH /me/businesses/:id',
  'POST /me/businesses/:id/branches',
  'PATCH /me/branches/:id',
  'GET /me/reviews',
  'POST /me/reviews/:id/reply',
  'GET /me/events',
  'POST /me/events',
  'PATCH /me/events/:id',
  'DELETE /me/events/:id',
  'GET /me/analytics/overview',
  'GET /me/analytics/traffic',
  'GET /me/analytics/demographics',
  'GET /me/analytics/search-terms',
  'GET /me/analytics/peak-hours',
  'GET /me/analytics/competitors',
  'GET /me/health-score',
  'POST /me/health-score/recommendations/:id/complete',
];
const CLAIM_ROUTES = ['GET /me/claims', 'POST /me/claims'];

const INTENDED: Record<string, { roles: UserRole[]; reason: string }> = {
  ...Object.fromEntries(
    OWNER_ROUTES.map((route) => [
      route,
      {
        roles: [UserRole.CUSTOMER, UserRole.SUPPORT, UserRole.MODERATOR, UserRole.ADMIN, UserRole.SUPER_ADMIN],
        reason:
          'owner capabilities (business.create / business.manage_own) are held by BUSINESS_OWNER only — not CUSTOMER, SUPPORT or platform staff (D-75, 15D.2)',
      },
    ]),
  ),
  ...Object.fromEntries(
    CLAIM_ROUTES.map((route) => [
      route,
      {
        roles: [UserRole.SUPPORT, UserRole.MODERATOR, UserRole.ADMIN, UserRole.SUPER_ADMIN],
        reason: 'business.claim is not held by SUPPORT or platform staff (D-75, 15D.2)',
      },
    ]),
  ),
};

// The only routes deliberately opened to callers WITHOUT an access token since
// fda2390, each with its replacement proof. Exactly one entry; adding another
// needs the same explicit review.
const INTENDED_PUBLIC: Record<string, string> = {
  'POST /auth/logout':
    'Phase 15E.4b: authenticated by possession of the session\'s current refresh token (AuthService.logout), ' +
    'so sign-out works after the access token expires. It can only END that one session — it grants nothing, ' +
    'returns nothing, and answers { success: true } for any token.',
};

describe('Old rank decisions vs new capability decisions', () => {
  const inventory = routeInventory();

  it('routes opened to anonymous callers are exactly the reviewed list, and each really was opened', () => {
    expect(Object.keys(INTENDED_PUBLIC)).toEqual(['POST /auth/logout']);
    for (const route of Object.keys(INTENDED_PUBLIC)) {
      const rule = inventory.find((e) => e.route === route)?.rule;
      expect({ route, legacy: LEGACY[route], now: rule?.kind }).toEqual({ route, legacy: 'auth', now: 'public' });
    }
  });

  it('the frozen legacy table covers exactly the current routes', () => {
    expect(inventory.map((e) => e.route).sort()).toEqual(Object.keys(LEGACY).sort());
  });

  it('the intended-change list names only real routes', () => {
    for (const route of [...OWNER_ROUTES, ...CLAIM_ROUTES]) expect(LEGACY[route]).toBeDefined();
  });

  it('every difference is an intended, documented change; nothing became MORE permissive', () => {
    const unexplained: string[] = [];
    const loosened: string[] = [];
    for (const { route, rule } of inventory) {
      for (const role of [...Object.values(UserRole), null]) {
        const before = legacyDecision(LEGACY[route], role);
        const after = decide(rule, role);
        if (before === after) continue;
        if (role === null && before === 'unauthenticated' && after === 'allow' && INTENDED_PUBLIC[route]) continue;
        if (after === 'allow') loosened.push(`${route} ${role}: ${before} → ${after}`);
        const intended = INTENDED[route];
        if (!(intended && role !== null && intended.roles.includes(role) && before === 'allow' && after === 'forbidden')) {
          unexplained.push(`${route} ${role}: ${before} → ${after}`);
        }
      }
    }
    expect(loosened).toEqual([]);
    expect(unexplained).toEqual([]);
  });

  it('every listed intended change actually happens (the list is not stale)', () => {
    for (const [route, { roles }] of Object.entries(INTENDED)) {
      const rule = inventory.find((e) => e.route === route)?.rule;
      for (const role of roles) {
        if (legacyDecision(LEGACY[route], role) === 'allow') {
          expect({ route, role, after: decide(rule, role) }).toEqual({ route, role, after: 'forbidden' });
        }
      }
    }
  });
});
