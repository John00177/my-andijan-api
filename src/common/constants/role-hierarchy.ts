import { UserRole } from '@prisma/client';

// Higher number = more privilege. SUPER_ADMIN sits above ADMIN so it
// automatically satisfies every @Roles(...) check without being listed
// explicitly everywhere.
export const ROLE_HIERARCHY: Record<UserRole, number> = {
  [UserRole.CUSTOMER]: 1,
  [UserRole.BUSINESS_OWNER]: 2,
  [UserRole.SUPPORT]: 3,
  [UserRole.MODERATOR]: 4,
  [UserRole.ADMIN]: 5,
  [UserRole.SUPER_ADMIN]: 6,
};
