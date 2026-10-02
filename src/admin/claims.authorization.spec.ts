import { UserRole } from '@prisma/client';
import { AdminController } from './admin.controller';
import { OwnerController } from '../owner/owner.controller';
import { decide, ruleOf } from '../authz/decide';

// REAL controller metadata, decided by AuthzGuard's own decision function
// (Phase 15D, D-75). Fails if anyone loosens a claim route's capability.
// That a reviewer cannot decide their OWN claim is a record-level policy —
// see src/authz/policies.spec.ts and admin.service.conflict.spec.ts.
describe('Claim route authorization', () => {
  const ROLES = Object.values(UserRole);

  const adminClaimHandlers = {
    'GET /admin/claims': AdminController.prototype.findClaims,
    'POST /admin/claims/:id/approve': AdminController.prototype.approveClaim,
    'POST /admin/claims/:id/reject': AdminController.prototype.rejectClaim,
  };

  for (const [route, handler] of Object.entries(adminClaimHandlers)) {
    describe(route, () => {
      const rule = ruleOf(AdminController, handler);

      it('requires claim.review', () => {
        expect(rule).toEqual({ kind: 'capability', capabilities: ['claim.review'] });
      });

      it.each([UserRole.CUSTOMER, UserRole.BUSINESS_OWNER, UserRole.SUPPORT, UserRole.MODERATOR])('denies %s', (role) => {
        expect(decide(rule, role)).toBe('forbidden');
      });

      it.each([UserRole.ADMIN, UserRole.SUPER_ADMIN])('allows %s', (role) => {
        expect(decide(rule, role)).toBe('allow');
      });

      it('refuses an unauthenticated request', () => {
        expect(decide(rule, null)).toBe('unauthenticated');
      });
    });
  }

  describe('POST/GET /me/claims (filing a claim)', () => {
    const handlers = [OwnerController.prototype.createClaim, OwnerController.prototype.findMyClaims];

    it('requires business.claim — no anonymous claims', () => {
      for (const handler of handlers) {
        const rule = ruleOf(OwnerController, handler);
        expect(rule).toEqual({ kind: 'capability', capabilities: ['business.claim'] });
        expect(decide(rule, null)).toBe('unauthenticated');
      }
    });

    it('is open to the roles that may own a business, closed to SUPPORT and MODERATOR', () => {
      const allowed: UserRole[] = [UserRole.CUSTOMER, UserRole.BUSINESS_OWNER, UserRole.ADMIN, UserRole.SUPER_ADMIN];
      for (const handler of handlers) {
        const rule = ruleOf(OwnerController, handler);
        for (const role of ROLES) {
          expect({ role, d: decide(rule, role) }).toEqual({ role, d: allowed.includes(role) ? 'allow' : 'forbidden' });
        }
      }
    });
  });
});
