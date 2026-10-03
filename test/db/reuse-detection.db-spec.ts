import { UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { OtpPurpose, Prisma, PrismaClient, SessionRevokedReason, UserRole } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import { createHash } from 'crypto';
import { AuthService } from '../../src/auth/auth.service';
import { AdminService } from '../../src/admin/admin.service';
import { JwtPayload, JwtStrategy } from '../../src/auth/strategies/jwt.strategy';
import { MAX_CLOCK_SKEW_MS, REFRESH_GRACE_WINDOW_MS } from '../../src/auth/refresh-sessions';
import { PrismaService } from '../../src/prisma/prisma.service';
import {
  createTestPrisma,
  createUser,
  PASSWORD,
  raceAtSessionLock,
  resetDatabase,
  services,
  waitForLockWaiters,
} from './support';

// Phase 15E.4c — refresh-token reuse detection against REAL PostgreSQL.
// A rotated token never yields a successor. Inside the grace window with its
// successor unused it is a harmless race (401, session untouched); otherwise it
// is reuse: that one session and all its tokens are revoked (REUSE_DETECTED),
// one audit row is written, and the answer is the same generic 401.

const DAY = 24 * 60 * 60 * 1000;
const AGED = 60_000; // comfortably outside the grace window
const sha256 = (raw: string) => createHash('sha256').update(raw).digest('hex');
const GENERIC_401 = { message: 'Invalid or expired refresh token', error: 'Unauthorized', statusCode: 401 };

describe('Refresh-token reuse detection on PostgreSQL (Phase 15E.4c)', () => {
  let prisma: PrismaClient;
  let auth: AuthService;
  let admin: AdminService;
  let phoneSeq = 0;
  const nextPhone = () => `+99891${String(1000000 + ++phoneSeq).slice(-7)}`;

  const tokenRow = (raw: string) => prisma.refreshToken.findUniqueOrThrow({ where: { tokenHash: sha256(raw) } });
  const refresh = (raw: string) => auth.refresh({ refreshToken: raw });
  const liveTokens = (where: Prisma.RefreshTokenWhereInput) =>
    prisma.refreshToken.count({ where: { ...where, revokedAt: null } });
  const sessionOf = async (raw: string) =>
    prisma.authSession.findUniqueOrThrow({ where: { id: (await tokenRow(raw)).sessionId! } });
  const reuseAudits = async () =>
    (await prisma.auditLog.findMany({ where: { entityType: 'AuthSession' } })).filter(
      (row) => (row.after as { reason?: string } | null)?.reason === SessionRevokedReason.REUSE_DETECTED,
    );

  async function signIn(phone?: string) {
    const user = await createUser(prisma, phone ?? nextPhone());
    const session = await auth.login({ phone: user.phone, password: PASSWORD });
    return { ...session, user };
  }

  /** Moves a rotated token's rotation into the past (outside the grace window). */
  async function age(raw: string, ms = AGED) {
    const row = await tokenRow(raw);
    await prisma.refreshToken.update({ where: { id: row.id }, data: { rotatedAt: new Date(Date.now() - ms) } });
  }

  async function refreshError(raw: string): Promise<UnauthorizedException> {
    const error = await refresh(raw).then(
      () => null,
      (e) => e,
    );
    expect(error).toBeInstanceOf(UnauthorizedException);
    return error as UnauthorizedException;
  }

  // Only Date is faked: Prisma's timers and the database keep running normally.
  function setNow(ms: number) {
    jest.useFakeTimers({
      doNotFake: [
        'hrtime', 'nextTick', 'performance', 'queueMicrotask', 'requestAnimationFrame', 'cancelAnimationFrame',
        'requestIdleCallback', 'cancelIdleCallback', 'setImmediate', 'clearImmediate', 'setInterval',
        'clearInterval', 'setTimeout', 'clearTimeout',
      ],
    });
    jest.setSystemTime(ms);
  }

  /**
   * Holds the session row while `first` and then `second` queue on its lock —
   * each observed waiting in pg_stat_activity before the next starts — then
   * releases it, so they run in exactly that order.
   */
  async function inOrderAtSessionLock(sessionId: number, first: () => Promise<unknown>, second: () => Promise<unknown>) {
    let results!: Promise<PromiseSettledResult<unknown>[]>;
    await prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT id FROM auth_sessions WHERE id = ${sessionId} FOR UPDATE`;
        const a = first();
        a.catch(() => undefined);
        await waitForLockWaiters(prisma, 'auth_sessions', 1);
        const b = second();
        b.catch(() => undefined);
        await waitForLockWaiters(prisma, 'auth_sessions', 2);
        results = Promise.allSettled([a, b]);
      },
      { timeout: 20_000 },
    );
    return results;
  }

  async function issueResetCode(phone: string) {
    await prisma.otpCode.create({
      data: {
        phone,
        purpose: OtpPurpose.PASSWORD_RESET,
        codeHash: await bcrypt.hash('135790', 4),
        expiresAt: new Date(Date.now() + 10 * 60_000),
      },
    });
  }

  beforeAll(async () => {
    prisma = createTestPrisma();
    await prisma.$connect();
    ({ auth, admin } = services(prisma));
  });
  afterAll(() => prisma.$disconnect());
  beforeEach(() => resetDatabase(prisma));
  afterEach(() => jest.useRealTimers());

  describe('classification', () => {
    it('1. rotated predecessor outside the grace window → generic 401, session and all its tokens revoked, one audit row', async () => {
      const { user, refreshToken: r1 } = await signIn();
      const { refreshToken: r2 } = await refresh(r1);
      await age(r1);

      const error = await refreshError(r1);

      expect(error.getResponse()).toEqual(GENERIC_401);
      const session = await sessionOf(r1);
      expect(session.revokedReason).toBe(SessionRevokedReason.REUSE_DETECTED);
      expect(await liveTokens({ sessionId: session.id })).toBe(0);
      await expect(refresh(r2)).rejects.toThrow(UnauthorizedException);
      const audits = await reuseAudits();
      expect(audits).toHaveLength(1);
      expect(audits[0]).toEqual(
        expect.objectContaining({
          action: 'UPDATE',
          entityType: 'AuthSession',
          entityId: session.id,
          actorId: user.id,
          actorRole: UserRole.CUSTOMER,
          before: { revoked: false },
          note: 'Refresh-token reuse detected — session revoked',
        }),
      );
      const after = audits[0].after as Record<string, unknown>;
      expect(after).toEqual({
        revoked: true,
        reason: 'REUSE_DETECTED',
        tokensRevoked: 1,
        presentedTokenId: (await tokenRow(r1)).id,
        successorUsed: false,
        rotatedAgoMs: expect.any(Number),
      });
      expect(after.rotatedAgoMs as number).toBeGreaterThanOrEqual(AGED);
    });

    it('2. inside the window, successor unused → 401, no successor, session stays active and untouched', async () => {
      const { refreshToken: r1 } = await signIn();
      const { refreshToken: r2 } = await refresh(r1);
      const before = await sessionOf(r1);
      const tokensBefore = await prisma.refreshToken.count();

      const error = await refreshError(r1);

      expect(error.getResponse()).toEqual(GENERIC_401);
      expect(await prisma.refreshToken.count()).toBe(tokensBefore); // no successor
      expect(await sessionOf(r1)).toEqual(before); // revokedAt null, lastUsedAt unchanged (rolled back)
      expect(await reuseAudits()).toHaveLength(0);
      await expect(refresh(r2)).resolves.toBeDefined();
    });

    it('3. inside the window but the successor already used → reuse', async () => {
      const { refreshToken: r1 } = await signIn();
      const { refreshToken: r2 } = await refresh(r1);
      const { refreshToken: r3 } = await refresh(r2);

      await refreshError(r1);

      expect((await sessionOf(r1)).revokedReason).toBe(SessionRevokedReason.REUSE_DETECTED);
      await expect(refresh(r3)).rejects.toThrow(UnauthorizedException);
      expect((await reuseAudits())[0].after).toEqual(expect.objectContaining({ successorUsed: true, tokensRevoked: 1 }));
    });

    it('4. exactly at the grace boundary (10 s) → harmless race', async () => {
      const t0 = Date.now();
      setNow(t0);
      const { refreshToken: r1 } = await signIn();
      await refresh(r1); // rotated at t0

      setNow(t0 + REFRESH_GRACE_WINDOW_MS);
      await refreshError(r1);

      expect((await sessionOf(r1)).revokedAt).toBeNull();
      expect(await reuseAudits()).toHaveLength(0);
    });

    it('5. one millisecond outside the grace window → reuse', async () => {
      const t0 = Date.now();
      setNow(t0);
      const { refreshToken: r1 } = await signIn();
      await refresh(r1);

      setNow(t0 + REFRESH_GRACE_WINDOW_MS + 1);
      await refreshError(r1);

      expect((await sessionOf(r1)).revokedReason).toBe(SessionRevokedReason.REUSE_DETECTED);
      expect(await reuseAudits()).toHaveLength(1);
    });

    it('6. rotation stamped ahead of this clock within the skew tolerance (5 s) → harmless race', async () => {
      const t0 = Date.now();
      setNow(t0);
      const { refreshToken: r1 } = await signIn();
      await refresh(r1);

      setNow(t0 - MAX_CLOCK_SKEW_MS); // this clock is 5 s behind the one that rotated
      await refreshError(r1);

      expect((await sessionOf(r1)).revokedAt).toBeNull();
      expect(await reuseAudits()).toHaveLength(0);
    });

    it('7. rotation stamped further ahead than the skew tolerance → reuse', async () => {
      const t0 = Date.now();
      setNow(t0);
      const { refreshToken: r1 } = await signIn();
      await refresh(r1);

      setNow(t0 - MAX_CLOCK_SKEW_MS - 1);
      await refreshError(r1);

      expect((await sessionOf(r1)).revokedReason).toBe(SessionRevokedReason.REUSE_DETECTED);
    });

    it('17. an expired rotated token is still reuse', async () => {
      const { refreshToken: r1 } = await signIn();
      await refresh(r1);
      const row = await tokenRow(r1);
      await prisma.refreshToken.update({
        where: { id: row.id },
        data: { rotatedAt: new Date(Date.now() - 31 * DAY), expiresAt: new Date(Date.now() - DAY) },
      });

      await refreshError(r1);

      expect((await sessionOf(r1)).revokedReason).toBe(SessionRevokedReason.REUSE_DETECTED);
      expect(await reuseAudits()).toHaveLength(1);
    });
  });

  describe('concurrency', () => {
    it('8. ten concurrent reuse attempts held at the session lock → exactly one revocation and one audit row', async () => {
      const { refreshToken: r1 } = await signIn();
      await refresh(r1);
      await age(r1);
      const sessionId = (await tokenRow(r1)).sessionId!;

      const results = await raceAtSessionLock(prisma, sessionId, 10, () =>
        Promise.allSettled(Array.from({ length: 10 }, () => refresh(r1))),
      );

      expect(results.every((r) => r.status === 'rejected' && r.reason instanceof UnauthorizedException)).toBe(true);
      expect(await reuseAudits()).toHaveLength(1);
      expect((await sessionOf(r1)).revokedReason).toBe(SessionRevokedReason.REUSE_DETECTED);
      expect(await liveTokens({ sessionId })).toBe(0);
    });

    it('8b. unsynchronised reuse bursts, 10 rounds: one audit row per detected session', async () => {
      for (let round = 0; round < 10; round++) {
        const { refreshToken: r1 } = await signIn();
        await refresh(r1);
        await age(r1);
        await Promise.allSettled(Array.from({ length: 5 }, () => refresh(r1)));
      }
      const audits = await reuseAudits();
      expect(audits).toHaveLength(10);
      expect(new Set(audits.map((a) => a.entityId)).size).toBe(10);
      expect(await prisma.authSession.count({ where: { revokedReason: SessionRevokedReason.REUSE_DETECTED } })).toBe(10);
    });

    it('9. attacker presents the predecessor after the legitimate client has refreshed on → reuse, the live chain dies', async () => {
      const { refreshToken: r1 } = await signIn();
      const { refreshToken: r2 } = await refresh(r1); // legitimate client
      const { refreshToken: r3 } = await refresh(r2); // ...and again

      await refreshError(r1); // attacker, seconds later

      expect((await sessionOf(r1)).revokedReason).toBe(SessionRevokedReason.REUSE_DETECTED);
      await expect(refresh(r3)).rejects.toThrow(UnauthorizedException);
    });

    it('9b. forced: the legitimate rotation of the successor commits first → the waiting stale request sees it used → reuse', async () => {
      const { refreshToken: r1 } = await signIn();
      const { refreshToken: r2 } = await refresh(r1); // R1 rotated just now: inside the window
      const sessionId = (await tokenRow(r1)).sessionId!;

      const [legit, stale] = await inOrderAtSessionLock(sessionId, () => refresh(r2), () => refresh(r1));

      expect(legit.status).toBe('fulfilled'); // R2 → R3 committed...
      expect(stale.status).toBe('rejected');
      // ...so the stale R1, judged on fresh state under the lock, has a used successor.
      expect((await sessionOf(r1)).revokedReason).toBe(SessionRevokedReason.REUSE_DETECTED);
      expect(await liveTokens({ sessionId })).toBe(0); // including the R3 just minted
      expect(await reuseAudits()).toHaveLength(1);
    });

    it('9c. forced: the stale request is first → reuse; the legitimate refresh then finds its session revoked', async () => {
      const { refreshToken: r1 } = await signIn();
      const { refreshToken: r2 } = await refresh(r1);
      await age(r1);
      const sessionId = (await tokenRow(r1)).sessionId!;

      const [stale, legit] = await inOrderAtSessionLock(sessionId, () => refresh(r1), () => refresh(r2));

      expect(stale.status).toBe('rejected');
      expect(legit.status).toBe('rejected');
      expect((await sessionOf(r1)).revokedReason).toBe(SessionRevokedReason.REUSE_DETECTED);
      expect(await liveTokens({ sessionId })).toBe(0);
      expect(await prisma.refreshToken.count({ where: { sessionId } })).toBe(2); // no successor was minted
      expect(await reuseAudits()).toHaveLength(1);
    });

    it('10. attacker refreshed first; the victim later presents the rotated token → reuse kills the attacker chain', async () => {
      const { refreshToken: r1 } = await signIn();
      const { refreshToken: attackerR2 } = await refresh(r1); // the attacker, with a stolen current token
      await age(r1); // the victim comes back later

      await refreshError(r1);

      expect((await sessionOf(r1)).revokedReason).toBe(SessionRevokedReason.REUSE_DETECTED);
      await expect(refresh(attackerR2)).rejects.toThrow(UnauthorizedException);
    });

    it('11. two legitimate tabs racing with the same token (held at the lock) → one successor, a harmless race, session intact', async () => {
      const { refreshToken: r1 } = await signIn();
      const sessionId = (await tokenRow(r1)).sessionId!;

      const results = await raceAtSessionLock(prisma, sessionId, 2, () => Promise.allSettled([refresh(r1), refresh(r1)]));

      const winners = results.filter((r) => r.status === 'fulfilled') as PromiseFulfilledResult<{ refreshToken: string }>[];
      expect(winners.length).toBe(1);
      expect((await prisma.authSession.findUniqueOrThrow({ where: { id: sessionId } })).revokedAt).toBeNull();
      expect(await reuseAudits()).toHaveLength(0);
      await expect(refresh(winners[0].value.refreshToken)).resolves.toBeDefined();
    });

    it('11b. unsynchronised legitimate double-sends, 20 rounds: never a revocation', async () => {
      for (let round = 0; round < 20; round++) {
        const { refreshToken: r1 } = await signIn();
        const results = await Promise.allSettled([refresh(r1), refresh(r1), refresh(r1)]);
        expect(results.filter((r) => r.status === 'fulfilled').length).toBe(1);
      }
      expect(await reuseAudits()).toHaveLength(0);
      expect(await prisma.authSession.count({ where: { revokedAt: { not: null } } })).toBe(0);
    });

    it('12. reuse racing logout — logout first: LOGOUT wins, the reuse attempt is a plain 401', async () => {
      const { refreshToken: r1 } = await signIn();
      const { refreshToken: r2 } = await refresh(r1);
      await age(r1);
      const sessionId = (await tokenRow(r1)).sessionId!;

      await inOrderAtSessionLock(sessionId, () => auth.logout(r2), () => refresh(r1));

      const session = await prisma.authSession.findUniqueOrThrow({ where: { id: sessionId } });
      expect(session.revokedReason).toBe(SessionRevokedReason.LOGOUT);
      expect(await liveTokens({ sessionId })).toBe(0);
      expect(await reuseAudits()).toHaveLength(0);
    });

    it('12b. reuse racing logout — reuse first: REUSE_DETECTED wins, logout ends nothing more', async () => {
      const { refreshToken: r1 } = await signIn();
      const { refreshToken: r2 } = await refresh(r1);
      await age(r1);
      const sessionId = (await tokenRow(r1)).sessionId!;

      const [, loggedOut] = await inOrderAtSessionLock(sessionId, () => refresh(r1), () => auth.logout(r2));

      expect(loggedOut).toEqual({ status: 'fulfilled', value: { success: true } });
      const session = await prisma.authSession.findUniqueOrThrow({ where: { id: sessionId } });
      expect(session.revokedReason).toBe(SessionRevokedReason.REUSE_DETECTED);
      expect(await liveTokens({ sessionId })).toBe(0);
      expect(await prisma.auditLog.count({ where: { entityType: 'AuthSession' } })).toBe(1);
    });

    it('13. reuse racing password reset — both orders: everything revoked, sessionVersion bumped, the first reason kept', async () => {
      for (const order of ['reset-first', 'reuse-first'] as const) {
        const { user, refreshToken: r1 } = await signIn();
        await refresh(r1);
        await age(r1);
        await issueResetCode(user.phone);
        const sessionId = (await tokenRow(r1)).sessionId!;
        const reset = () => auth.resetPassword({ phone: user.phone, code: '135790', newPassword: 'brand-new-password' });

        if (order === 'reset-first') await inOrderAtSessionLock(sessionId, reset, () => refresh(r1));
        else await inOrderAtSessionLock(sessionId, () => refresh(r1), reset);

        const session = await prisma.authSession.findUniqueOrThrow({ where: { id: sessionId } });
        expect(session.revokedReason).toBe(
          order === 'reset-first' ? SessionRevokedReason.PASSWORD_RESET : SessionRevokedReason.REUSE_DETECTED,
        );
        expect(await liveTokens({ userId: user.id })).toBe(0);
        expect((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).sessionVersion).toBe(user.sessionVersion + 1);
      }
      expect(await reuseAudits()).toHaveLength(1); // only in the reuse-first round
    });

    it('14. reuse racing suspension — both orders: everything revoked, the first reason kept; reinstatement revives nothing', async () => {
      const actor = await createUser(prisma, nextPhone(), UserRole.SUPER_ADMIN);
      const staff = { id: actor.id, phone: actor.phone, role: UserRole.SUPER_ADMIN };
      for (const order of ['suspend-first', 'reuse-first'] as const) {
        const { user, refreshToken: r1 } = await signIn();
        const { refreshToken: r2 } = await refresh(r1);
        await age(r1);
        const sessionId = (await tokenRow(r1)).sessionId!;
        const suspend = () => admin.suspendUser(user.id, staff, 'Fraud report');

        if (order === 'suspend-first') await inOrderAtSessionLock(sessionId, suspend, () => refresh(r1));
        else await inOrderAtSessionLock(sessionId, () => refresh(r1), suspend);

        const session = await prisma.authSession.findUniqueOrThrow({ where: { id: sessionId } });
        expect(session.revokedReason).toBe(
          order === 'suspend-first' ? SessionRevokedReason.SUSPENDED : SessionRevokedReason.REUSE_DETECTED,
        );
        expect(await liveTokens({ userId: user.id })).toBe(0);
        await admin.activateUser(user.id, staff, 'Cleared');
        await expect(refresh(r2)).rejects.toThrow(UnauthorizedException);
        expect(await prisma.authSession.count({ where: { userId: user.id, revokedAt: null } })).toBe(0);
      }
      expect(await reuseAudits()).toHaveLength(1);
    });
  });

  describe('dead sessions and revoked-but-unrotated tokens', () => {
    it('15. a rotated token of an already revoked session → plain 401, no audit, the reason is unchanged', async () => {
      const { refreshToken: r1 } = await signIn();
      const { refreshToken: r2 } = await refresh(r1);
      await auth.logout(r2);
      await age(r1);

      const error = await refreshError(r1);

      expect(error.getResponse()).toEqual(GENERIC_401);
      expect((await sessionOf(r1)).revokedReason).toBe(SessionRevokedReason.LOGOUT);
      expect(await reuseAudits()).toHaveLength(0);
    });

    it('16. a rotated token of a session past its absolute expiry → plain 401, session not revoked, no audit', async () => {
      const { refreshToken: r1 } = await signIn();
      await refresh(r1);
      await age(r1);
      const sessionId = (await tokenRow(r1)).sessionId!;
      await prisma.authSession.update({ where: { id: sessionId }, data: { absoluteExpiresAt: new Date(Date.now() - 1000) } });

      await refreshError(r1);

      expect((await prisma.authSession.findUniqueOrThrow({ where: { id: sessionId } })).revokedAt).toBeNull();
      expect(await reuseAudits()).toHaveLength(0);
    });

    it('18. a token revoked without ever being rotated, in a live session → plain 401, not reuse: session untouched, no audit', async () => {
      // The "not-rotated" branch of the classification (15E.4c), now that no
      // session-less row can carry it (15E.4e.1): revoked_at set, rotated_at NULL.
      const { refreshToken: r1 } = await signIn();
      const row = await tokenRow(r1);
      await prisma.refreshToken.update({ where: { id: row.id }, data: { revokedAt: new Date(Date.now() - 60 * 60_000) } });

      const error = await refreshError(r1);

      expect(error.getResponse()).toEqual(GENERIC_401);
      const session = await prisma.authSession.findUniqueOrThrow({ where: { id: row.sessionId } });
      expect(session.revokedAt).toBeNull();
      expect(await reuseAudits()).toHaveLength(0);
      expect(await prisma.refreshToken.count({ where: { parentId: row.id } })).toBe(0); // no successor
    });
  });

  describe('isolation, uniformity and secrecy', () => {
    it('19. reuse in one session leaves the user’s other sessions, access tokens and sessionVersion untouched', async () => {
      const a = await signIn();
      const b = await auth.login({ phone: a.user.phone, password: PASSWORD });
      await refresh(a.refreshToken);
      await age(a.refreshToken);

      await refreshError(a.refreshToken);

      expect((await sessionOf(a.refreshToken)).revokedReason).toBe(SessionRevokedReason.REUSE_DETECTED);
      expect((await sessionOf(b.refreshToken)).revokedAt).toBeNull();
      expect((await prisma.user.findUniqueOrThrow({ where: { id: a.user.id } })).sessionVersion).toBe(a.user.sessionVersion);
      const jwt = new JwtService({});
      const strategy = new JwtStrategy(prisma as unknown as PrismaService);
      const payload = jwt.verify<JwtPayload>(b.accessToken, { secret: process.env.JWT_ACCESS_SECRET });
      await expect(strategy.validate(payload)).resolves.toEqual(expect.objectContaining({ id: a.user.id }));
      await expect(refresh(b.refreshToken)).resolves.toBeDefined();
    });

    it('20. reuse, harmless race, unknown token, revoked session, expired session and expired token answer identically', async () => {
      const bodies: unknown[] = [];
      const collect = async (raw: string) => {
        const error = await refreshError(raw);
        expect(error.getStatus()).toBe(401);
        bodies.push(error.getResponse());
      };

      const reuse = await signIn();
      await refresh(reuse.refreshToken);
      await age(reuse.refreshToken);
      await collect(reuse.refreshToken); // reuse

      const race = await signIn();
      await refresh(race.refreshToken);
      await collect(race.refreshToken); // harmless race

      await collect('0'.repeat(96)); // unknown

      const revoked = await signIn();
      await auth.logout(revoked.refreshToken);
      await collect(revoked.refreshToken); // revoked session

      const expiredSession = await signIn();
      await prisma.authSession.update({
        where: { id: (await tokenRow(expiredSession.refreshToken)).sessionId! },
        data: { absoluteExpiresAt: new Date(Date.now() - 1000) },
      });
      await collect(expiredSession.refreshToken); // expired session

      const expiredToken = await signIn();
      await prisma.refreshToken.update({
        where: { id: (await tokenRow(expiredToken.refreshToken)).id },
        data: { expiresAt: new Date(Date.now() - 1000) },
      });
      await collect(expiredToken.refreshToken); // expired token

      expect(bodies).toHaveLength(6);
      for (const body of bodies) expect(body).toEqual(GENERIC_401);
    });

    it('21. neither the raw token nor its hash reaches a log line or an audit row; the log lines carry IDs', async () => {
      const output: string[] = [];
      const capture = (stream: NodeJS.WriteStream) =>
        jest.spyOn(stream, 'write').mockImplementation((chunk: string | Uint8Array) => (output.push(String(chunk)), true));
      const spies: jest.SpyInstance[] = [capture(process.stdout), capture(process.stderr)];
      for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) {
        spies.push(
          jest.spyOn(console, level).mockImplementation((...args: unknown[]) => void output.push(args.map(String).join(' '))),
        );
      }

      let raws: string[] = [];
      let sessionId = 0;
      try {
        const race = await signIn();
        const { refreshToken: raceNext } = await refresh(race.refreshToken);
        await refresh(race.refreshToken).catch(() => undefined); // harmless race → logged
        const reuse = await signIn();
        const { refreshToken: reuseNext } = await refresh(reuse.refreshToken);
        await age(reuse.refreshToken);
        await refresh(reuse.refreshToken).catch(() => undefined); // reuse → logged + audited
        raws = [race.refreshToken, raceNext, reuse.refreshToken, reuseNext];
        sessionId = (await tokenRow(reuse.refreshToken)).sessionId!;
      } finally {
        spies.forEach((spy) => spy.mockRestore());
      }

      const logs = output.join('\n');
      const audits = JSON.stringify(await prisma.auditLog.findMany());
      expect(logs.includes('Refresh grace-window race refused')).toBe(true);
      expect(logs.includes(`Refresh-token reuse detected; session revoked (session=${sessionId} `)).toBe(true);
      for (const raw of raws) {
        expect(logs.includes(raw)).toBe(false);
        expect(audits.includes(raw)).toBe(false);
        expect(logs.includes(sha256(raw))).toBe(false);
        expect(audits.includes(sha256(raw))).toBe(false);
      }
    });
  });
});
