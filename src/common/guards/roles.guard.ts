import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { UserRole } from '@prisma/client';
import { ROLES_KEY } from '../decorators/roles.decorator';
import { ROLE_HIERARCHY } from '../constants/role-hierarchy';
import { AuthenticatedUser } from '../../auth/strategies/jwt.strategy';

// Hierarchy check, not exact-match: @Roles(...) declares the FLOOR a caller
// must clear (the lowest-privilege role in the list), and anyone at or above
// that level passes — so SUPER_ADMIN satisfies every @Roles(...) check
// without needing to be listed explicitly on each route.
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const requiredRoles = this.reflector.getAllAndOverride<UserRole[]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (!requiredRoles || requiredRoles.length === 0) {
      return true;
    }

    const request = context.switchToHttp().getRequest();
    const user: AuthenticatedUser | undefined = request.user;
    if (!user) return false;

    const requiredLevel = Math.min(...requiredRoles.map((role) => ROLE_HIERARCHY[role]));
    return ROLE_HIERARCHY[user.role] >= requiredLevel;
  }
}
