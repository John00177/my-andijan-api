import { UserRole } from '@prisma/client';
import { BusinessMenuController, MenuItemController, OwnerMenuController } from './products.controller';
import { decide, ruleOf } from '../authz/decide';

// Real controller metadata (Phase 15D, D-75). The public catalog read is
// @Public; every catalog write — and the owner-side read — requires
// `business.manage_own` at the route AND ownership of the business in
// ProductsService (products.service.spec.ts has the per-role ownership
// matrix). SUPPORT and MODERATOR hold no owner capability.
describe('Catalog route authorization', () => {
  it('leaves the public catalog read open (anonymous customers can browse a menu)', () => {
    const rule = ruleOf(BusinessMenuController, BusinessMenuController.prototype.findAll);
    expect(rule).toEqual({ kind: 'public' });
    expect(decide(rule, null)).toBe('allow');
  });

  const ownerRoutes: Array<[string, new (...args: never[]) => unknown, (...args: never[]) => unknown]> = [
    ['POST /businesses/:id/menu', BusinessMenuController, BusinessMenuController.prototype.create],
    ['GET /me/businesses/:id/menu', OwnerMenuController, OwnerMenuController.prototype.findMine],
    ['PATCH /menu/:id', MenuItemController, MenuItemController.prototype.update],
    ['DELETE /menu/:id', MenuItemController, MenuItemController.prototype.remove],
  ];

  it.each(ownerRoutes)('%s requires exactly business.manage_own', (_route, controller, handler) => {
    expect(ruleOf(controller, handler)).toEqual({ kind: 'capability', capabilities: ['business.manage_own'] });
  });

  it.each(ownerRoutes)('%s: refused to CUSTOMER, SUPPORT, MODERATOR and anonymous callers', (_route, controller, handler) => {
    const rule = ruleOf(controller, handler);
    for (const role of [UserRole.CUSTOMER, UserRole.SUPPORT, UserRole.MODERATOR]) expect(decide(rule, role)).toBe('forbidden');
    for (const role of [UserRole.BUSINESS_OWNER, UserRole.ADMIN, UserRole.SUPER_ADMIN]) expect(decide(rule, role)).toBe('allow');
    expect(decide(rule, null)).toBe('unauthenticated');
  });
});
