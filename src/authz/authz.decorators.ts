import { SetMetadata } from '@nestjs/common';
import { Capability } from './capabilities';

// Every route declares exactly ONE authorization rule (Phase 15D, D-75).
// AuthzGuard is global and DENIES any route that declares none, so a new
// endpoint cannot ship unprotected by accident; route-authorization.spec.ts
// fails CI first. A method-level rule overrides a controller-level one.
export const AUTHZ_RULE = 'authz:rule';

export type AuthzRule =
  | { kind: 'public' }
  | { kind: 'authenticated' }
  | { kind: 'capability'; capabilities: Capability[] }
  | { kind: 'governance'; action: string };

/** Anyone, signed in or not. */
export const Public = () => SetMetadata(AUTHZ_RULE, { kind: 'public' } satisfies AuthzRule);

/**
 * Any signed-in account, acting only on its own account data (profile,
 * favorites, uploads, RSVPs). Never use this for an action whose permission
 * should differ by role — that is a capability.
 */
export const Authenticated = () => SetMetadata(AUTHZ_RULE, { kind: 'authenticated' } satisfies AuthzRule);

/** Signed in AND the caller's role holds every listed capability. */
export const RequireCapability = (...capabilities: [Capability, ...Capability[]]) =>
  SetMetadata(AUTHZ_RULE, { kind: 'capability', capabilities } satisfies AuthzRule);

/**
 * PLACEHOLDER for the future PLATFORM_OWNER governance plane. Governance is
 * deliberately NOT implemented: AuthzGuard refuses every request to a route
 * carrying this rule, for every role, SUPER_ADMIN included. No route uses it.
 */
export const RequireGovernance = (action: string) =>
  SetMetadata(AUTHZ_RULE, { kind: 'governance', action } satisfies AuthzRule);
