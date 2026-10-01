import { GUARDS_METADATA } from '@nestjs/common/constants';
import { Reflector } from '@nestjs/core';
import { UserRole } from '@prisma/client';
import { BusinessMenuController, MenuItemController, OwnerMenuController } from './products.controller';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { ROLES_KEY } from '../common/decorators/roles.decorator';

// Real controller metadata. Since Phase 15B (D-74) every catalog write — and
// the owner-side read — is OWNER-ONLY: JwtAuthGuard authenticates and
// ProductsService.assertOwner decides, with NO role floor. A floor is exactly
// what used to let SUPPORT (rank 3 > BUSINESS_OWNER 2) and MODERATOR in by
// rank; these tests fail if anyone re-adds one. The per-role ownership matrix
// itself is in products.service.spec.ts.
describe('Catalog route authorization', () => {
  const reflector = new Reflector();

  it('leaves the public catalog read unguarded (anonymous customers can browse a menu)', () => {
    expect(Reflect.getMetadata(GUARDS_METADATA, BusinessMenuController)).toBeUndefined();
    expect(Reflect.getMetadata(GUARDS_METADATA, BusinessMenuController.prototype.findAll)).toBeUndefined();
  });

  it('guards the owner catalog read with JwtAuthGuard only', () => {
    expect(Reflect.getMetadata(GUARDS_METADATA, OwnerMenuController)).toEqual([JwtAuthGuard]);
  });

  it('guards every catalog write with JwtAuthGuard only', () => {
    expect(Reflect.getMetadata(GUARDS_METADATA, BusinessMenuController.prototype.create)).toEqual([JwtAuthGuard]);
    expect(Reflect.getMetadata(GUARDS_METADATA, MenuItemController.prototype.update)).toEqual([JwtAuthGuard]);
    expect(Reflect.getMetadata(GUARDS_METADATA, MenuItemController.prototype.remove)).toEqual([JwtAuthGuard]);
  });

  const ownerRoutes: Array<[string, new (...args: never[]) => unknown, (...args: never[]) => unknown]> = [
    ['POST /businesses/:id/menu', BusinessMenuController, BusinessMenuController.prototype.create],
    ['GET /me/businesses/:id/menu', OwnerMenuController, OwnerMenuController.prototype.findMine],
    ['PATCH /menu/:id', MenuItemController, MenuItemController.prototype.update],
    ['DELETE /menu/:id', MenuItemController, MenuItemController.prototype.remove],
  ];

  it.each(ownerRoutes)('%s declares no @Roles — no role can be admitted (or excluded) by rank', (_route, controller, handler) => {
    expect(reflector.getAllAndOverride<UserRole[] | undefined>(ROLES_KEY, [handler, controller])).toBeUndefined();
  });
});
