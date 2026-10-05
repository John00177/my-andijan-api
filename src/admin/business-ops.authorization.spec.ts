import { UserRole } from '@prisma/client';
import { AdminController } from './admin.controller';
import { decide, ruleOf } from '../authz/decide';

// REAL AdminController metadata, decided by the same function AuthzGuard
// uses (Phase 15D, D-75). Each group lists the capability the route must
// require and — written out by hand, not derived — exactly which roles pass.
// Fails if anyone loosens a route's capability or a role gains/loses one.
describe('Business operations route authorization', () => {
  const ROLES = Object.values(UserRole);
  const MOD_UP = [UserRole.MODERATOR, UserRole.ADMIN, UserRole.SUPER_ADMIN];
  const ADMINS = [UserRole.ADMIN, UserRole.SUPER_ADMIN];
  const SUPER = [UserRole.SUPER_ADMIN];

  const groups: { capability: string; allowed: UserRole[]; routes: Record<string, (...args: never[]) => unknown> }[] = [
    {
      // Phase 14 moderator surface (D-72), now explicit capabilities.
      capability: 'business.review',
      allowed: MOD_UP,
      routes: {
        'GET /admin/businesses': AdminController.prototype.findBusinesses,
        // Phase 16E: the review drawer's full listing — same capability as the queue.
        'GET /admin/businesses/:id': AdminController.prototype.findBusinessById,
        'POST /admin/businesses/:id/approve': AdminController.prototype.approveBusiness,
        'POST /admin/businesses/:id/reject': AdminController.prototype.rejectBusiness,
      },
    },
    {
      capability: 'review.moderate',
      allowed: MOD_UP,
      routes: {
        'GET /admin/reviews': AdminController.prototype.findReviews,
        'POST /admin/reviews/:id/hide': AdminController.prototype.hideReview,
        'POST /admin/reviews/:id/restore': AdminController.prototype.restoreReview,
      },
    },
    {
      capability: 'report.resolve',
      allowed: MOD_UP,
      routes: {
        'GET /admin/reports': AdminController.prototype.findReports,
        'POST /admin/reports/:id/resolve': AdminController.prototype.resolveReport,
      },
    },
    {
      capability: 'business.edit_any',
      allowed: ADMINS,
      routes: {
        'PATCH /admin/businesses/:id': AdminController.prototype.updateBusiness,
        'PATCH /admin/businesses/:id/branch': AdminController.prototype.updateBusinessBranch,
        'PUT /admin/businesses/:id/hours': AdminController.prototype.updateBusinessHours,
      },
    },
    {
      capability: 'business.operate',
      allowed: ADMINS,
      routes: {
        'POST /admin/businesses/:id/verify': AdminController.prototype.verifyBusiness,
        'POST /admin/businesses/:id/unverify': AdminController.prototype.unverifyBusiness,
        'POST /admin/businesses/:id/suspend': AdminController.prototype.suspendBusiness,
        'POST /admin/businesses/:id/unsuspend': AdminController.prototype.unsuspendBusiness,
        'POST /admin/businesses/:id/promote': AdminController.prototype.promoteBusiness,
        'POST /admin/businesses/:id/unpromote': AdminController.prototype.unpromoteBusiness,
      },
    },
    { capability: 'analytics.platform', allowed: ADMINS, routes: { 'GET /admin/stats': AdminController.prototype.getStats } },
    { capability: 'user.pii.read', allowed: ADMINS, routes: { 'GET /admin/users': AdminController.prototype.findUsers } },
    {
      capability: 'user.status.manage',
      allowed: ADMINS,
      routes: {
        'POST /admin/users/:id/suspend': AdminController.prototype.suspendUser,
        'POST /admin/users/:id/activate': AdminController.prototype.activateUser,
      },
    },
    { capability: 'audit.read', allowed: ADMINS, routes: { 'GET /admin/audit': AdminController.prototype.findAuditLogs } },
    {
      capability: 'event.review',
      allowed: ADMINS,
      routes: {
        'GET /admin/events': AdminController.prototype.findEvents,
        'POST /admin/events/:id/approve': AdminController.prototype.approveEvent,
        'POST /admin/events/:id/reject': AdminController.prototype.rejectEvent,
      },
    },
    {
      capability: 'taxonomy.manage',
      allowed: ADMINS,
      routes: {
        'GET /admin/categories': AdminController.prototype.findCategories,
        'POST /admin/categories': AdminController.prototype.createCategory,
        'PATCH /admin/categories/reorder': AdminController.prototype.reorderCategories,
        'PATCH /admin/categories/:id': AdminController.prototype.updateCategory,
        'DELETE /admin/categories/:id': AdminController.prototype.deleteCategory,
        'PATCH /admin/districts/:id': AdminController.prototype.updateDistrict,
        'PATCH /admin/cities/:id': AdminController.prototype.updateCity,
      },
    },
    {
      capability: 'business.hide',
      allowed: SUPER,
      routes: {
        'PATCH /admin/businesses/:id/hide': AdminController.prototype.hideBusiness,
        'PATCH /admin/businesses/:id/unhide': AdminController.prototype.unhideBusiness,
      },
    },
  ];

  for (const { capability, allowed, routes } of groups) {
    for (const [route, handler] of Object.entries(routes)) {
      describe(`${route} (${capability})`, () => {
        const rule = ruleOf(AdminController, handler);

        it(`requires exactly ${capability}`, () => {
          expect(rule).toEqual({ kind: 'capability', capabilities: [capability] });
        });

        it.each(ROLES.filter((r) => !allowed.includes(r)))('denies %s', (role) => {
          expect(decide(rule, role)).toBe('forbidden');
        });

        it.each(allowed)('allows %s', (role) => {
          expect(decide(rule, role)).toBe('allow');
        });

        it('refuses an unauthenticated request', () => {
          expect(decide(rule, null)).toBe('unauthenticated');
        });
      });
    }
  }

  it('every AdminController route carries an explicit rule (no class-level fallback remains)', () => {
    const handlers = Object.getOwnPropertyNames(AdminController.prototype).filter((n) => n !== 'constructor');
    for (const name of handlers) {
      const handler = (AdminController.prototype as unknown as Record<string, (...a: never[]) => unknown>)[name];
      expect({ name, rule: ruleOf(AdminController, handler)?.kind }).toEqual({ name, rule: 'capability' });
    }
  });

  it('never lets SUPPORT reach any admin route (SUPPORT holds no staff capability)', () => {
    for (const { routes } of groups) {
      for (const handler of Object.values(routes)) {
        expect(decide(ruleOf(AdminController, handler), UserRole.SUPPORT)).toBe('forbidden');
      }
    }
  });

  it('never lets a BUSINESS_OWNER reach any admin route', () => {
    for (const { routes } of groups) {
      for (const handler of Object.values(routes)) {
        expect(decide(ruleOf(AdminController, handler), UserRole.BUSINESS_OWNER)).toBe('forbidden');
      }
    }
  });

  it('MODERATOR reaches only the moderation capabilities, never ADMIN operations', () => {
    for (const { capability, routes } of groups) {
      for (const handler of Object.values(routes)) {
        const expected = ['business.review', 'review.moderate', 'report.resolve'].includes(capability) ? 'allow' : 'forbidden';
        expect(decide(ruleOf(AdminController, handler), UserRole.MODERATOR)).toBe(expected);
      }
    }
  });
});
