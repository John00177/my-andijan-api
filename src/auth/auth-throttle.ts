import { ThrottlerModuleOptions } from '@nestjs/throttler';
import { resolveClientIp } from '../common/request-context/request-context';

// Rate limiting for the credential and SMS-code endpoints (Phase 15B).
//
// Two independent buckets per route:
//   ip    — per client address per minute. Generous, because Uzbek mobile
//           carriers put many subscribers behind one CGNAT address.
//   phone — per target phone number per 15 minutes. This is the one that
//           stops password guessing and SMS-code brute force against a single
//           account regardless of how many addresses the attacker uses.
//
// Storage is the throttler's default in-process memory. That is correct for
// the current deployment (Railway, numReplicas = 1) and resets on redeploy;
// running more than one replica would need a shared store (e.g. Redis) — see
// SECURITY.md. The OTP-send cap in AuthService (counted in the database) stays
// as the durable second line for SMS volume.
const MINUTE = 60_000;
const QUARTER_HOUR = 15 * MINUTE;

function clientIpTracker(req: Record<string, any>): string {
  // Same resolver the audit log uses: X-Real-IP only behind Railway's edge,
  // the TCP peer otherwise. Never X-Forwarded-For.
  return `ip:${resolveClientIp(req as Parameters<typeof resolveClientIp>[0]) ?? 'unknown'}`;
}

function phoneTracker(req: Record<string, any>): string {
  const phone = typeof req.body?.phone === 'string' ? req.body.phone.replace(/\s+/g, '') : '';
  // No phone in the body: fall back to the address, so the bucket still exists.
  return phone ? `phone:${phone}` : clientIpTracker(req);
}

export const AUTH_THROTTLER_OPTIONS: ThrottlerModuleOptions = {
  throttlers: [
    { name: 'ip', ttl: MINUTE, limit: 60, getTracker: clientIpTracker },
    { name: 'phone', ttl: QUARTER_HOUR, limit: 10, getTracker: phoneTracker },
  ],
  errorMessage: 'Too many attempts. Please wait and try again.',
};

// Per-route limits, applied with @Throttle(AUTH_LIMITS.x).
export const AUTH_LIMITS = {
  login: { ip: { limit: 60, ttl: MINUTE }, phone: { limit: 10, ttl: QUARTER_HOUR } },
  register: { ip: { limit: 10, ttl: MINUTE }, phone: { limit: 5, ttl: QUARTER_HOUR } },
  refresh: { ip: { limit: 120, ttl: MINUTE } },
  otpRequest: { ip: { limit: 20, ttl: MINUTE }, phone: { limit: 5, ttl: QUARTER_HOUR } },
  otpVerify: { ip: { limit: 60, ttl: MINUTE }, phone: { limit: 10, ttl: QUARTER_HOUR } },
  forgotPassword: { ip: { limit: 20, ttl: MINUTE }, phone: { limit: 5, ttl: QUARTER_HOUR } },
  verifyResetCode: { ip: { limit: 60, ttl: MINUTE }, phone: { limit: 10, ttl: QUARTER_HOUR } },
  resetPassword: { ip: { limit: 20, ttl: MINUTE }, phone: { limit: 5, ttl: QUARTER_HOUR } },
} as const;
