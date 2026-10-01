import { ExecutionContext } from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { Reflector } from '@nestjs/core';
import { UserRole } from '@prisma/client';
import { AdminController } from './admin.controller';
import { OwnerController } from '../owner/owner.controller';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';

// Uses a REAL Reflector against the REAL controller metadata (unlike
// roles.guard.spec.ts, which mocks the reflector), so this fails if anyone
// adds a lower @Roles() override to a claim route or drops a guard.
describe('Claim route authorization', () => {
  const guard = new RolesGuard(new Reflector());

  function contextFor(handler: (...args: never[]) => unknown, role?: UserRole): ExecutionContext {
    return {
      getHandler: () => handler,
      getClass: () => AdminController,
      switchToHttp: () => ({ getRequest: () => ({ user: role ? { id: 1, phone: '+998901234567', role } : undefined }) }),
    } as unknown as ExecutionContext;
  }

  const adminClaimHandlers = {
    'GET /admin/claims': AdminController.prototype.findClaims,
    'POST /admin/claims/:id/approve': AdminController.prototype.approveClaim,
    'POST /admin/claims/:id/reject': AdminController.prototype.rejectClaim,
  };

  it('protects the whole admin controller with JwtAuthGuard and RolesGuard', () => {
    expect(Reflect.getMetadata(GUARDS_METADATA, AdminController)).toEqual([JwtAuthGuard, RolesGuard]);
  });

  it('protects POST/GET /me/claims with JwtAuthGuard (no anonymous claims)', () => {
    expect(Reflect.getMetadata(GUARDS_METADATA, OwnerController)).toEqual([JwtAuthGuard]);
  });

  for (const [route, handler] of Object.entries(adminClaimHandlers)) {
    describe(route, () => {
      it.each([UserRole.CUSTOMER, UserRole.BUSINESS_OWNER, UserRole.SUPPORT, UserRole.MODERATOR])(
        'denies %s',
        (role) => {
          expect(guard.canActivate(contextFor(handler, role))).toBe(false);
        },
      );

      it.each([UserRole.ADMIN, UserRole.SUPER_ADMIN])('allows %s', (role) => {
        expect(guard.canActivate(contextFor(handler, role))).toBe(true);
      });

      it('denies a request with no authenticated user', () => {
        expect(guard.canActivate(contextFor(handler))).toBe(false);
      });
    });
  }
});
