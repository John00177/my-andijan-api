import { ForbiddenException } from '@nestjs/common';
import { UserRole } from '@prisma/client';

// Who may change whose account status (Phase 15B, D-74; target model 15C).
// Explicit sets, deliberately NOT derived from ROLE_HIERARCHY: a higher rank
// never implies authority over another account. Anything absent is denied.
//
// - No one acts on themselves (checked before these tables).
// - No one in the application can suspend or reinstate a SUPER_ADMIN. The
//   founder currently holds SUPER_ADMIN, so this is also what keeps the future
//   PLATFORM_OWNER out of reach of every operational role until the
//   governance plane exists.
// - SUPER_ADMIN may suspend an ADMIN only as an emergency freeze (containment).
//   Lifting or confirming that freeze is reserved for PLATFORM_OWNER
//   governance, which does not exist yet — so no role may reinstate an ADMIN.
// - SUPER_ADMIN is NOT a staff-governance authority: there is no API that
//   changes any role (see role-write-inventory.spec.ts).
export const SUSPENDABLE_TARGETS: Readonly<Record<UserRole, ReadonlySet<UserRole>>> = {
  [UserRole.CUSTOMER]: new Set(),
  [UserRole.BUSINESS_OWNER]: new Set(),
  [UserRole.SUPPORT]: new Set(),
  [UserRole.MODERATOR]: new Set(),
  [UserRole.ADMIN]: new Set([UserRole.CUSTOMER, UserRole.BUSINESS_OWNER]),
  [UserRole.SUPER_ADMIN]: new Set([
    UserRole.CUSTOMER,
    UserRole.BUSINESS_OWNER,
    UserRole.MODERATOR,
    UserRole.SUPPORT,
    UserRole.ADMIN, // emergency freeze only — see isEmergencyFreeze
  ]),
};

export const REACTIVATABLE_TARGETS: Readonly<Record<UserRole, ReadonlySet<UserRole>>> = {
  [UserRole.CUSTOMER]: new Set(),
  [UserRole.BUSINESS_OWNER]: new Set(),
  [UserRole.SUPPORT]: new Set(),
  [UserRole.MODERATOR]: new Set(),
  [UserRole.ADMIN]: new Set([UserRole.CUSTOMER, UserRole.BUSINESS_OWNER]),
  [UserRole.SUPER_ADMIN]: new Set([UserRole.CUSTOMER, UserRole.BUSINESS_OWNER, UserRole.MODERATOR, UserRole.SUPPORT]),
};

export type UserStatusChange = 'suspend' | 'activate';

export function assertCanChangeUserStatus(
  actor: { id: number; role: UserRole },
  target: { id: number; role: UserRole },
  change: UserStatusChange,
): void {
  if (actor.id === target.id) {
    throw new ForbiddenException('You cannot change the status of your own account');
  }
  const allowed = change === 'suspend' ? SUSPENDABLE_TARGETS[actor.role] : REACTIVATABLE_TARGETS[actor.role];
  if (!allowed.has(target.role)) {
    if (change === 'activate' && target.role === UserRole.ADMIN) {
      throw new ForbiddenException('An emergency-frozen ADMIN can only be reinstated by the platform owner');
    }
    throw new ForbiddenException(`A ${actor.role} cannot ${change} a ${target.role} account`);
  }
}

export function isEmergencyFreeze(actorRole: UserRole, targetRole: UserRole): boolean {
  return actorRole === UserRole.SUPER_ADMIN && targetRole === UserRole.ADMIN;
}
