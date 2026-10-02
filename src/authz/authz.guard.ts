import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { AuthenticatedUser } from '../auth/strategies/jwt.strategy';
import { AUTHZ_RULE, AuthzRule } from './authz.decorators';
import { decide } from './decide';

// The single, global, deny-by-default authorization guard (Phase 15D, D-75),
// registered as APP_GUARD so it runs before every controller guard.
//
//   no rule          → 403 (fail closed: an undeclared route is never open)
//   @Public          → allowed, no authentication
//   @Authenticated   → valid JWT for an ACTIVE account with a current session
//   @RequireCapability(...caps) → authenticated AND role holds every cap
//   @RequireGovernance → 403 always (governance plane not implemented)
//
// Authentication is delegated to the existing passport JwtStrategy (which
// reloads the user per request and enforces status + session_version), so a
// missing/invalid token is 401 and an authenticated-but-not-permitted caller
// is 403. Record-level rules (ownership, conflict of interest, target tables)
// live in the services via src/authz/policies.ts.
@Injectable()
export class AuthzGuard implements CanActivate {
  private readonly jwt = new JwtAuthGuard();

  constructor(private readonly reflector: Reflector) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const rule = this.reflector.getAllAndOverride<AuthzRule | undefined>(AUTHZ_RULE, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (!rule) {
      throw new ForbiddenException('This route declares no authorization rule');
    }
    if (rule.kind === 'public') return true;
    if (rule.kind === 'governance') {
      throw new ForbiddenException('Platform governance is not available');
    }

    await this.jwt.canActivate(context); // throws 401 if not authenticated
    if (rule.kind === 'authenticated') return true;

    const user: AuthenticatedUser | undefined = context.switchToHttp().getRequest().user;
    if (decide(rule, user?.role ?? null) !== 'allow') {
      throw new ForbiddenException('You do not have permission to perform this action');
    }
    return true;
  }
}
