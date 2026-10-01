import { UserRole } from '@prisma/client';
import {
  auditRequestFields,
  isBehindRailwayEdge,
  requestContextMiddleware,
  resolveClientIp,
  setRequestActorRole,
} from './request-context';

// Phase 15B. The client address recorded in audit rows and used as the
// rate-limit key must not be something a client can choose.
describe('resolveClientIp', () => {
  const railway = { RAILWAY_ENVIRONMENT_NAME: 'production' } as NodeJS.ProcessEnv;
  const local = {} as NodeJS.ProcessEnv;
  const req = (headers: Record<string, string | string[]>, peer = '10.0.0.9') => ({
    headers,
    socket: { remoteAddress: peer },
  });

  it('detects Railway from the variables Railway injects', () => {
    expect(isBehindRailwayEdge(railway)).toBe(true);
    expect(isBehindRailwayEdge({ RAILWAY_ENVIRONMENT_ID: 'x' } as NodeJS.ProcessEnv)).toBe(true);
    expect(isBehindRailwayEdge(local)).toBe(false);
  });

  it("behind Railway's edge, uses the edge-set X-Real-IP", () => {
    expect(resolveClientIp(req({ 'x-real-ip': '203.0.113.5' }), railway)).toBe('203.0.113.5');
    expect(resolveClientIp(req({ 'x-real-ip': '2001:db8::1' }), railway)).toBe('2001:db8::1');
  });

  it('never reads X-Forwarded-For (client-appendable), on or off Railway', () => {
    expect(resolveClientIp(req({ 'x-forwarded-for': '1.2.3.4' }), railway)).toBe('10.0.0.9');
    expect(resolveClientIp(req({ 'x-forwarded-for': '1.2.3.4' }), local)).toBe('10.0.0.9');
  });

  it('ignores X-Real-IP entirely when not behind the edge (it would be client-supplied)', () => {
    expect(resolveClientIp(req({ 'x-real-ip': '1.2.3.4' }), local)).toBe('10.0.0.9');
  });

  it('rejects a malformed X-Real-IP instead of recording arbitrary text', () => {
    expect(resolveClientIp(req({ 'x-real-ip': "'); DROP TABLE users;--" }), railway)).toBe('10.0.0.9');
    expect(resolveClientIp(req({ 'x-real-ip': '999.1.1.1' }), railway)).toBe('10.0.0.9');
  });

  it('returns null when there is no address at all', () => {
    expect(resolveClientIp({ headers: {} }, local)).toBeNull();
  });
});

describe('requestContextMiddleware', () => {
  function run(headers: Record<string, string>) {
    const res = { setHeader: jest.fn() };
    let captured: ReturnType<typeof auditRequestFields> | undefined;
    requestContextMiddleware(
      { headers, socket: { remoteAddress: '127.0.0.1' } } as never,
      res as never,
      () => {
        setRequestActorRole(UserRole.ADMIN);
        captured = auditRequestFields();
      },
    );
    return { res, captured: captured! };
  }

  it('stamps a server-generated request id, the address, the user agent and (once authenticated) the role', () => {
    const { res, captured } = run({ 'user-agent': 'Mozilla/5.0', 'x-request-id': 'attacker-chosen' });

    expect(captured.requestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(captured.requestId).not.toBe('attacker-chosen');
    expect(captured.ipAddress).toBe('127.0.0.1');
    expect(captured.userAgent).toBe('Mozilla/5.0');
    expect(captured.actorRole).toBe(UserRole.ADMIN);
    expect(res.setHeader).toHaveBeenCalledWith('X-Request-Id', captured.requestId);
  });

  it('truncates an oversized user agent to the column width', () => {
    const { captured } = run({ 'user-agent': 'x'.repeat(2000) });
    expect(captured.userAgent).toHaveLength(500);
  });

  it('yields all-null audit fields outside a request (scripts, background work)', () => {
    expect(auditRequestFields()).toEqual({ ipAddress: null, userAgent: null, requestId: null, actorRole: null });
  });
});
