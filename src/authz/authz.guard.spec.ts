import { Controller, ExecutionContext, ForbiddenException, Get, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { UserRole } from '@prisma/client';
import { AuthzGuard } from './authz.guard';
import { Authenticated, Public, RequireCapability, RequireGovernance } from './authz.decorators';

// AuthzGuard behaviour (Phase 15D, D-75), against real decorator metadata on
// a throwaway controller. Authentication is the passport JWT guard; here it
// is stubbed to either succeed (setting req.user) or throw 401.
@Controller('probe')
class ProbeController {
  @Get('undeclared') undeclared() {}
  @Public() @Get('public') open() {}
  @Authenticated() @Get('mine') mine() {}
  @RequireCapability('business.review') @Get('moderate') moderate() {}
  @RequireCapability('business.review', 'business.operate') @Get('both') both() {}
  @RequireGovernance('owner.transfer') @Get('governance') governance() {}
}

@RequireCapability('audit.read')
@Controller('class-level')
class ClassLevelController {
  @Get() inherited() {}
  @Public() @Get('open') overridden() {}
}

describe('AuthzGuard', () => {
  let guard: AuthzGuard;
  let jwt: jest.SpyInstance;
  let request: { user?: { id: number; role: UserRole } };

  function context(controller: object, handler: (...a: never[]) => unknown): ExecutionContext {
    return {
      getHandler: () => handler,
      getClass: () => controller,
      switchToHttp: () => ({ getRequest: () => request }),
    } as unknown as ExecutionContext;
  }

  function signInAs(role: UserRole) {
    jwt.mockImplementation(async () => {
      request.user = { id: 1, role };
      return true;
    });
  }

  beforeEach(() => {
    guard = new AuthzGuard(new Reflector());
    request = {};
    jwt = jest
      .spyOn((guard as unknown as { jwt: { canActivate: () => Promise<boolean> } }).jwt, 'canActivate')
      .mockRejectedValue(new UnauthorizedException());
  });

  const P = ProbeController.prototype;

  it('refuses a route that declares no rule — default deny, even for SUPER_ADMIN', async () => {
    signInAs(UserRole.SUPER_ADMIN);
    await expect(guard.canActivate(context(ProbeController, P.undeclared))).rejects.toThrow(ForbiddenException);
  });

  it('lets anyone through a @Public route without authenticating', async () => {
    await expect(guard.canActivate(context(ProbeController, P.open))).resolves.toBe(true);
    expect(jwt).not.toHaveBeenCalled();
  });

  it('requires a valid session for @Authenticated (401 otherwise)', async () => {
    await expect(guard.canActivate(context(ProbeController, P.mine))).rejects.toThrow(UnauthorizedException);
    signInAs(UserRole.CUSTOMER);
    await expect(guard.canActivate(context(ProbeController, P.mine))).resolves.toBe(true);
  });

  it('401s an unauthenticated caller on a capability route before checking capabilities', async () => {
    await expect(guard.canActivate(context(ProbeController, P.moderate))).rejects.toThrow(UnauthorizedException);
  });

  it.each([UserRole.MODERATOR, UserRole.ADMIN, UserRole.SUPER_ADMIN])('allows %s holding the capability', async (role) => {
    signInAs(role);
    await expect(guard.canActivate(context(ProbeController, P.moderate))).resolves.toBe(true);
  });

  it.each([UserRole.CUSTOMER, UserRole.BUSINESS_OWNER, UserRole.SUPPORT])('403s %s lacking it', async (role) => {
    signInAs(role);
    await expect(guard.canActivate(context(ProbeController, P.moderate))).rejects.toThrow(ForbiddenException);
  });

  it('requires EVERY listed capability, not any one of them', async () => {
    signInAs(UserRole.MODERATOR); // has business.review, lacks business.operate
    await expect(guard.canActivate(context(ProbeController, P.both))).rejects.toThrow(ForbiddenException);
    signInAs(UserRole.ADMIN);
    await expect(guard.canActivate(context(ProbeController, P.both))).resolves.toBe(true);
  });

  it.each(Object.values(UserRole))('refuses the governance placeholder for %s — governance is not implemented', async (role) => {
    signInAs(role);
    await expect(guard.canActivate(context(ProbeController, P.governance))).rejects.toThrow(ForbiddenException);
  });

  it('applies a controller-level rule to handlers, and a method-level rule overrides it', async () => {
    const C = ClassLevelController.prototype;
    signInAs(UserRole.MODERATOR);
    await expect(guard.canActivate(context(ClassLevelController, C.inherited))).rejects.toThrow(ForbiddenException);
    await expect(guard.canActivate(context(ClassLevelController, C.overridden))).resolves.toBe(true);
  });
});
