import { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { UserRole } from '@prisma/client';
import { RolesGuard } from './roles.guard';
import { AuthenticatedUser } from '../../auth/strategies/jwt.strategy';

describe('RolesGuard', () => {
  // The admin surface — including the new GET /admin/reviews route — relies
  // entirely on this guard for "non-admin cannot access". A floor-vs-exact
  // mistake here would silently open every @Roles(ADMIN) route.

  function guardWith(requiredRoles: UserRole[] | undefined) {
    const reflector = { getAllAndOverride: jest.fn().mockReturnValue(requiredRoles) } as unknown as Reflector;
    return new RolesGuard(reflector);
  }

  function contextFor(user: AuthenticatedUser | undefined): ExecutionContext {
    return {
      getHandler: () => ({}),
      getClass: () => ({}),
      switchToHttp: () => ({ getRequest: () => ({ user }) }),
    } as unknown as ExecutionContext;
  }

  it('denies a request with no authenticated user at all', () => {
    const guard = guardWith([UserRole.ADMIN]);
    expect(guard.canActivate(contextFor(undefined))).toBe(false);
  });

  it('denies a non-admin (CUSTOMER) caller on an ADMIN-floor route', () => {
    const guard = guardWith([UserRole.ADMIN]);
    const user: AuthenticatedUser = { id: 1, phone: '+998901234567', role: UserRole.CUSTOMER };
    expect(guard.canActivate(contextFor(user))).toBe(false);
  });

  it('denies a BUSINESS_OWNER caller on an ADMIN-floor route', () => {
    const guard = guardWith([UserRole.ADMIN]);
    const user: AuthenticatedUser = { id: 1, phone: '+998901234567', role: UserRole.BUSINESS_OWNER };
    expect(guard.canActivate(contextFor(user))).toBe(false);
  });

  it('allows an ADMIN caller on an ADMIN-floor route', () => {
    const guard = guardWith([UserRole.ADMIN]);
    const user: AuthenticatedUser = { id: 1, phone: '+998901234567', role: UserRole.ADMIN };
    expect(guard.canActivate(contextFor(user))).toBe(true);
  });

  it('allows a SUPER_ADMIN caller on an ADMIN-floor route (hierarchy, not exact match)', () => {
    const guard = guardWith([UserRole.ADMIN]);
    const user: AuthenticatedUser = { id: 1, phone: '+998901234567', role: UserRole.SUPER_ADMIN };
    expect(guard.canActivate(contextFor(user))).toBe(true);
  });

  it('allows any authenticated user when the route declares no @Roles() at all', () => {
    const guard = guardWith(undefined);
    const user: AuthenticatedUser = { id: 1, phone: '+998901234567', role: UserRole.CUSTOMER };
    expect(guard.canActivate(contextFor(user))).toBe(true);
  });
});
