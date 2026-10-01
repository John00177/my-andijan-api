import { ExecutionContext } from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { Reflector } from '@nestjs/core';
import { UserRole } from '@prisma/client';
import { AdminController } from './admin.controller';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';

// REAL Reflector against the REAL AdminController metadata — fails if anyone
// lowers a @Roles() override on a business operation or drops a guard. Each
// group lists the exact floor the route is meant to have.
describe('Business operations route authorization', () => {
  const guard = new RolesGuard(new Reflector());
  // Ordered by ROLE_HIERARCHY, lowest first.
  const RANKS = [
    UserRole.CUSTOMER,
    UserRole.BUSINESS_OWNER,
    UserRole.SUPPORT,
    UserRole.MODERATOR,
    UserRole.ADMIN,
    UserRole.SUPER_ADMIN,
  ];

  function contextFor(handler: (...args: never[]) => unknown, role?: UserRole): ExecutionContext {
    return {
      getHandler: () => handler,
      getClass: () => AdminController,
      switchToHttp: () => ({ getRequest: () => ({ user: role ? { id: 1, phone: '+998901234567', role } : undefined }) }),
    } as unknown as ExecutionContext;
  }

  const groups: { floor: UserRole; routes: Record<string, (...args: never[]) => unknown> }[] = [
    {
      // Phase 14 moderator policy (D-72): exactly the business-approval and
      // review/report moderation surface — nothing else.
      floor: UserRole.MODERATOR,
      routes: {
        'GET /admin/businesses': AdminController.prototype.findBusinesses,
        'POST /admin/businesses/:id/approve': AdminController.prototype.approveBusiness,
        'POST /admin/businesses/:id/reject': AdminController.prototype.rejectBusiness,
        'GET /admin/reviews': AdminController.prototype.findReviews,
        'POST /admin/reviews/:id/hide': AdminController.prototype.hideReview,
        'POST /admin/reviews/:id/restore': AdminController.prototype.restoreReview,
        'GET /admin/reports': AdminController.prototype.findReports,
        'POST /admin/reports/:id/resolve': AdminController.prototype.resolveReport,
      },
    },
    {
      floor: UserRole.ADMIN,
      routes: {
        'GET /admin/stats': AdminController.prototype.getStats,
        'GET /admin/users': AdminController.prototype.findUsers,
        'POST /admin/users/:id/suspend': AdminController.prototype.suspendUser,
        'POST /admin/users/:id/activate': AdminController.prototype.activateUser,
        'GET /admin/audit': AdminController.prototype.findAuditLogs,
        'POST /admin/events/:id/approve': AdminController.prototype.approveEvent,
        'POST /admin/categories': AdminController.prototype.createCategory,
        'PATCH /admin/businesses/:id': AdminController.prototype.updateBusiness,
        'PATCH /admin/businesses/:id/branch': AdminController.prototype.updateBusinessBranch,
        // Phase 15B: the staff counterpart of the now owner-only hours route.
        'PUT /admin/businesses/:id/hours': AdminController.prototype.updateBusinessHours,
        'POST /admin/businesses/:id/verify': AdminController.prototype.verifyBusiness,
        'POST /admin/businesses/:id/unverify': AdminController.prototype.unverifyBusiness,
        'POST /admin/businesses/:id/suspend': AdminController.prototype.suspendBusiness,
        'POST /admin/businesses/:id/unsuspend': AdminController.prototype.unsuspendBusiness,
        'POST /admin/businesses/:id/promote': AdminController.prototype.promoteBusiness,
        'POST /admin/businesses/:id/unpromote': AdminController.prototype.unpromoteBusiness,
      },
    },
    {
      floor: UserRole.SUPER_ADMIN,
      routes: {
        'PATCH /admin/businesses/:id/hide': AdminController.prototype.hideBusiness,
        'PATCH /admin/businesses/:id/unhide': AdminController.prototype.unhideBusiness,
      },
    },
  ];

  it('protects the whole admin controller with JwtAuthGuard and RolesGuard', () => {
    expect(Reflect.getMetadata(GUARDS_METADATA, AdminController)).toEqual([JwtAuthGuard, RolesGuard]);
  });

  for (const { floor, routes } of groups) {
    const allowed = RANKS.slice(RANKS.indexOf(floor));
    const denied = RANKS.slice(0, RANKS.indexOf(floor));

    for (const [route, handler] of Object.entries(routes)) {
      describe(`${route} (floor: ${floor})`, () => {
        it.each(denied)('denies %s', (role) => {
          expect(guard.canActivate(contextFor(handler, role))).toBe(false);
        });

        it.each(allowed)('allows %s', (role) => {
          expect(guard.canActivate(contextFor(handler, role))).toBe(true);
        });

        it('denies a request with no authenticated user', () => {
          expect(guard.canActivate(contextFor(handler))).toBe(false);
        });
      });
    }
  }

  it('never lets SUPPORT reach any moderation route (SUPPORT ranks below MODERATOR)', () => {
    for (const { routes } of groups) {
      for (const handler of Object.values(routes)) {
        expect(guard.canActivate(contextFor(handler, UserRole.SUPPORT))).toBe(false);
      }
    }
  });

  it('never lets a BUSINESS_OWNER reach any business operation', () => {
    for (const { routes } of groups) {
      for (const handler of Object.values(routes)) {
        expect(guard.canActivate(contextFor(handler, UserRole.BUSINESS_OWNER))).toBe(false);
      }
    }
  });
});
