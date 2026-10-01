import { ExecutionContext } from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { Reflector } from '@nestjs/core';
import { UserRole } from '@prisma/client';
import { BusinessMenuController, MenuItemController, OwnerMenuController } from './products.controller';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';

// Real Reflector against the real controller metadata, so this fails if a
// catalog write route ever loses a guard or has its @Roles floor lowered.
// The per-business ownership check is NOT a guard concern — it lives in
// ProductsService.assertCanManage and is covered in products.service.spec.ts.
describe('Catalog route authorization', () => {
  const guard = new RolesGuard(new Reflector());

  function contextFor(
    controller: new (...args: never[]) => unknown,
    handler: (...args: never[]) => unknown,
    role?: UserRole,
  ): ExecutionContext {
    return {
      getHandler: () => handler,
      getClass: () => controller,
      switchToHttp: () => ({ getRequest: () => ({ user: role ? { id: 1, phone: '+998901234567', role } : undefined }) }),
    } as unknown as ExecutionContext;
  }

  it('leaves the public catalog read unguarded (anonymous customers can browse a menu)', () => {
    expect(Reflect.getMetadata(GUARDS_METADATA, BusinessMenuController)).toBeUndefined();
  });

  it('guards the owner catalog read with JwtAuthGuard and RolesGuard', () => {
    expect(Reflect.getMetadata(GUARDS_METADATA, OwnerMenuController)).toEqual([JwtAuthGuard, RolesGuard]);
  });

  const writeRoutes: Array<[string, new (...args: never[]) => unknown, (...args: never[]) => unknown]> = [
    ['POST /businesses/:id/menu', BusinessMenuController, BusinessMenuController.prototype.create],
    ['GET /me/businesses/:id/menu', OwnerMenuController, OwnerMenuController.prototype.findMine],
    ['PATCH /menu/:id', MenuItemController, MenuItemController.prototype.update],
    ['DELETE /menu/:id', MenuItemController, MenuItemController.prototype.remove],
  ];

  for (const [route, controller, handler] of writeRoutes) {
    describe(route, () => {
      it('denies CUSTOMER', () => {
        expect(guard.canActivate(contextFor(controller, handler, UserRole.CUSTOMER))).toBe(false);
      });

      it.each([UserRole.BUSINESS_OWNER, UserRole.MODERATOR, UserRole.ADMIN, UserRole.SUPER_ADMIN])(
        'allows %s (ownership is then enforced in the service)',
        (role) => {
          expect(guard.canActivate(contextFor(controller, handler, role))).toBe(true);
        },
      );

      // SUPPORT(3) outranks BUSINESS_OWNER(2) in ROLE_HIERARCHY, so it clears
      // this floor on every @Roles(BUSINESS_OWNER) route in the app, not just
      // the catalog — a pre-existing, documented quirk (CURRENT_STATE.md known
      // bug #9), asserted here so changing the hierarchy trips a test instead
      // of silently moving a boundary. It is not a hole: ProductsService
      // .assertCanManage still requires owner-or-MODERATOR+, and SUPPORT(3) is
      // below MODERATOR(4) — see products.service.spec.ts.
      it('lets SUPPORT past the role floor, leaving the service to reject it', () => {
        expect(guard.canActivate(contextFor(controller, handler, UserRole.SUPPORT))).toBe(true);
      });

      it('denies a request with no authenticated user', () => {
        expect(guard.canActivate(contextFor(controller, handler))).toBe(false);
      });
    });
  }

  it('guards the per-item write routes on MenuItemController', () => {
    expect(Reflect.getMetadata(GUARDS_METADATA, MenuItemController.prototype.update)).toEqual([
      JwtAuthGuard,
      RolesGuard,
    ]);
    expect(Reflect.getMetadata(GUARDS_METADATA, MenuItemController.prototype.remove)).toEqual([
      JwtAuthGuard,
      RolesGuard,
    ]);
  });

  it('guards POST /businesses/:id/menu while leaving the sibling GET public', () => {
    expect(Reflect.getMetadata(GUARDS_METADATA, BusinessMenuController.prototype.create)).toEqual([
      JwtAuthGuard,
      RolesGuard,
    ]);
    expect(Reflect.getMetadata(GUARDS_METADATA, BusinessMenuController.prototype.findAll)).toBeUndefined();
  });
});
