import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { isIP } from 'node:net';
import { UserRole } from '@prisma/client';
import type { NextFunction, Request, Response } from 'express';

// Per-request facts every audit row needs (who, from where, which request),
// carried through AsyncLocalStorage so services deep inside a transaction can
// stamp them without every controller threading req through (Phase 15B).
export interface RequestContext {
  requestId: string;
  ipAddress: string | null;
  userAgent: string | null;
  // Filled in by JwtStrategy.validate once the caller is authenticated — the
  // role as loaded from the database for THIS request, not the token claim.
  actorRole?: UserRole;
}

const storage = new AsyncLocalStorage<RequestContext>();

const MAX_USER_AGENT = 500;
const MAX_IP = 45;

// Railway's edge sets X-Real-IP to the connecting client's address
// (docs.railway.com/networking/public-networking/specs-and-limits). It is
// trusted ONLY when the process is actually running on Railway, where every
// request arrives through that edge. X-Forwarded-For is never read: it is
// client-appendable and Railway doesn't document how it treats it. Anywhere
// else (local dev, tests) the TCP peer address is the only trustworthy value.
export function isBehindRailwayEdge(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.RAILWAY_ENVIRONMENT_NAME || env.RAILWAY_ENVIRONMENT_ID || env.RAILWAY_ENVIRONMENT);
}

export function resolveClientIp(
  req: Pick<Request, 'headers'> & { socket?: { remoteAddress?: string | undefined } },
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  if (isBehindRailwayEdge(env)) {
    const header = req.headers['x-real-ip'];
    const value = (Array.isArray(header) ? header[0] : header)?.trim();
    if (value && isIP(value)) return value.slice(0, MAX_IP);
  }
  const peer = req.socket?.remoteAddress;
  return peer ? peer.slice(0, MAX_IP) : null;
}

export function requestContextMiddleware(req: Request, res: Response, next: NextFunction): void {
  const userAgent = req.headers['user-agent'];
  const context: RequestContext = {
    // Always server-generated — a client-supplied id would let a caller make
    // unrelated audit rows look correlated.
    requestId: randomUUID(),
    ipAddress: resolveClientIp(req),
    userAgent: typeof userAgent === 'string' ? userAgent.slice(0, MAX_USER_AGENT) : null,
  };
  res.setHeader('X-Request-Id', context.requestId);
  storage.run(context, () => next());
}

export function getRequestContext(): RequestContext | undefined {
  return storage.getStore();
}

export function runWithRequestContext<T>(context: RequestContext, fn: () => T): T {
  return storage.run(context, fn);
}

export function setRequestActorRole(role: UserRole): void {
  const context = storage.getStore();
  if (context) context.actorRole = role;
}

// Spread into every auditLog.create data block. Outside an HTTP request
// (scripts, tests) the fields are simply null.
export function auditRequestFields(): {
  ipAddress: string | null;
  userAgent: string | null;
  requestId: string | null;
  actorRole: UserRole | null;
} {
  const context = storage.getStore();
  return {
    ipAddress: context?.ipAddress ?? null,
    userAgent: context?.userAgent ?? null,
    requestId: context?.requestId ?? null,
    actorRole: context?.actorRole ?? null,
  };
}
