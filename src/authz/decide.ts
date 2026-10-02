import { UserRole } from '@prisma/client';
import { Reflector } from '@nestjs/core';
import { AUTHZ_RULE, AuthzRule } from './authz.decorators';
import { hasCapability } from './capabilities';

export type Decision = 'allow' | 'unauthenticated' | 'forbidden';

// The route-level decision as a pure function of (rule, caller role) — the
// exact logic AuthzGuard applies after authentication, extracted so the
// authorization matrix tests exercise the same code. `role === null` means
// no valid credentials were presented.
export function decide(rule: AuthzRule | undefined, role: UserRole | null): Decision {
  if (!rule) return 'forbidden'; // undeclared route: fail closed
  if (rule.kind === 'public') return 'allow';
  if (rule.kind === 'governance') return 'forbidden'; // governance plane not implemented
  if (role === null) return 'unauthenticated';
  if (rule.kind === 'authenticated') return 'allow';
  return rule.capabilities.every((capability) => hasCapability(role, capability)) ? 'allow' : 'forbidden';
}

const reflector = new Reflector();

/** The rule a handler actually carries (method-level overrides class-level). */
export function ruleOf(
  controller: abstract new (...args: never[]) => unknown,
  handler: (...args: never[]) => unknown,
): AuthzRule | undefined {
  return reflector.getAllAndOverride<AuthzRule | undefined>(AUTHZ_RULE, [handler, controller]);
}
