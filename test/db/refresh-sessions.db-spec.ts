import { UnauthorizedException } from '@nestjs/common';
import { OtpPurpose, Prisma, PrismaClient, SessionRevokedReason, UserRole, UserStatus } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import { createHash } from 'crypto';
import { AuthService } from '../../src/auth/auth.service';
import { AdminService } from '../../src/admin/admin.service';
import { isWithinRefreshGraceWindow, MAX_CLOCK_SKEW_MS, REFRESH_GRACE_WINDOW_MS } from '../../src/auth/refresh-sessions';
import { runWithRequestContext } from '../../src/common/request-context/request-context';
import {
  createTestPrisma,
  createUser,
  inRolledBackTransaction,
  PASSWORD,
  raceAtSessionLock,
  resetDatabase,
  services,
  waitForLockWaiters,
} from './support';

// Phase 15E.4b — refresh-token sessions against REAL PostgreSQL. In-memory
// fakes cannot prove row-lock semantics; these tests can. The central
// invariant: ONE refresh-token predecessor NEVER produces TWO valid successors.

const DAY = 24 * 60 * 60 * 1000;
const sha256 = (raw: string) => createHash('sha256').update(raw).digest('hex');

describe('Refresh-token sessions on PostgreSQL (Phase 15E.4b)', () => {
  let prisma: PrismaClient;
  let auth: AuthService;
  let admin: AdminService;
  let phoneSeq = 0;
  const nextPhone = () => `+99890${String(1000000 + ++phoneSeq).slice(-7)}`;

  const tokenRow = (raw: string) => prisma.refreshToken.findUniqueOrThrow({ where: { tokenHash: sha256(raw) } });
  const refresh = (raw: string) => auth.refresh({ refreshToken: raw });

  async function signIn(phone?: string) {
    const user = await createUser(prisma, phone ?? nextPhone());
    const session = await auth.login({ phone: user.phone, password: PASSWORD });
    return { ...session, user };
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

  beforeAll(async () => {
    prisma = createTestPrisma();
    await prisma.$connect();
    ({ auth, admin } = services(prisma));
  });
  afterAll(() => prisma.$disconnect());
  beforeEach(() => resetDatabase(prisma));
  afterEach(() => jest.useRealTimers());

  describe('sign-in', () => {
    it('login, registration and SMS-code sign-in each create exactly one session holding one hashed token', async () => {
      await signIn();
      const registered = await auth.register({ phone: nextPhone(), password: PASSWORD, fullName: 'New' });
      const otpPhone = nextPhone();
      await prisma.otpCode.create({
        data: {
          phone: otpPhone,
          purpose: OtpPurpose.LOGIN,
          codeHash: await bcrypt.hash('246810', 4),
          expiresAt: new Date(Date.now() + 60_000),
        },
      });
      const viaOtp = await auth.verifyOtp({ phone: otpPhone, otp: '246810' });

      const sessions = await prisma.authSession.findMany({ include: { refreshTokens: true } });
      expect(sessions).toHaveLength(3);
      for (const session of sessions) {
        expect(session.refreshTokens).toHaveLength(1);
        expect(session.absoluteExpiresAt.getTime() - session.createdAt.getTime()).toBe(90 * DAY);
        expect(session.refreshTokens[0].expiresAt.getTime()).toBeLessThanOrEqual(session.absoluteExpiresAt.getTime());
      }
      expect((await tokenRow(registered.refreshToken)).tokenHash).toBe(sha256(registered.refreshToken));
      expect((await tokenRow(viaOtp.refreshToken)).sessionId).toEqual(expect.any(Number));
    });

    it('captures the device metadata at sign-in, bounded to the column widths', async () => {
      const user = await createUser(prisma, nextPhone());
      await runWithRequestContext(
        { requestId: 'req-1', ipAddress: '203.0.113.7', userAgent: `Mozilla/5.0 ${'x'.repeat(700)}` },
        () => auth.login({ phone: user.phone, password: PASSWORD }),
      );
      const session = await prisma.authSession.findFirstOrThrow();
      expect(session.ipAddress).toBe('203.0.113.7');
      expect(session.userAgent).toHaveLength(500);
      expect(session.userAgent!.startsWith('Mozilla/5.0')).toBe(true);
    });
  });

  describe('TEST 1 — concurrent refresh of one token', () => {
    async function expectExactlyOneWinner(results: PromiseSettledResult<{ refreshToken: string }>[], r1Id: number) {
      const winners = results.filter((r) => r.status === 'fulfilled') as PromiseFulfilledResult<{ refreshToken: string }>[];
      const losers = results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];
      // Counts and booleans only: a failure must never print a token.
      expect(winners.length).toBe(1);
      expect(losers.length).toBe(results.length - 1);
      for (const loser of losers) {
        expect(loser.reason).toBeInstanceOf(UnauthorizedException);
        expect(loser.reason.message).toBe('Invalid or expired refresh token');
      }

      // Exactly one row has parent_id = R1, and it is the winner's token.
      const successors = await prisma.refreshToken.findMany({ where: { parentId: r1Id } });
      expect(successors).toHaveLength(1);
      expect(successors[0].tokenHash === sha256(winners[0].value.refreshToken)).toBe(true);
      expect(successors[0]).toEqual(expect.objectContaining({ rotatedAt: null, revokedAt: null }));
      return winners[0].value;
    }

    it('two requests provably waiting at the session lock together: one successor, the loser revokes nothing', async () => {
      const { refreshToken } = await signIn();
      const r1 = await tokenRow(refreshToken);

      const results = await raceAtSessionLock(prisma, r1.sessionId!, 2, () =>
        Promise.allSettled([refresh(refreshToken), refresh(refreshToken)]),
      );
      const winner = await expectExactlyOneWinner(results, r1.id);

      const session = await prisma.authSession.findUniqueOrThrow({ where: { id: r1.sessionId! } });
      expect(session.revokedAt).toBeNull();
      expect(await prisma.refreshToken.count()).toBe(2);
      expect((await tokenRow(refreshToken)).rotatedAt).toEqual(expect.any(Date));
      await expect(refresh(winner.refreshToken)).resolves.toBeDefined(); // the session still works
    });

    it('ten requests held at the lock together, five rounds: always exactly one successor', async () => {
      for (let round = 0; round < 5; round++) {
        const { refreshToken } = await signIn();
        const r1 = await tokenRow(refreshToken);
        const results = await raceAtSessionLock(prisma, r1.sessionId!, 10, () =>
          Promise.allSettled(Array.from({ length: 10 }, () => refresh(refreshToken))),
        );
        await expectExactlyOneWinner(results, r1.id);
      }
    });

    it('unsynchronised bursts (no lock held by the test), 25 rounds: always exactly one successor', async () => {
      for (let round = 0; round < 25; round++) {
        const { refreshToken } = await signIn();
        const r1 = await tokenRow(refreshToken);
        const results = await Promise.allSettled(Array.from({ length: 4 }, () => refresh(refreshToken)));
        await expectExactlyOneWinner(results, r1.id);
      }
      // Globally: no token has more than one successor.
      const duplicates = await prisma.$queryRaw<unknown[]>`
        SELECT parent_id FROM refresh_tokens WHERE parent_id IS NOT NULL GROUP BY parent_id HAVING count(*) > 1`;
      expect(duplicates).toEqual([]);
    });
  });

  it('TEST 2 — a chain R1 → R2 → R3 → R4 stays one linked line in one session with a fixed absolute expiry', async () => {
    const { refreshToken } = await signIn();
    const raws = [refreshToken];
    const sessionBefore = await prisma.authSession.findFirstOrThrow();
    for (let i = 0; i < 3; i++) raws.push((await refresh(raws[i])).refreshToken);

    const rows = await Promise.all(raws.map(tokenRow));
    expect(rows[0].parentId).toBeNull();
    for (let i = 1; i < rows.length; i++) expect(rows[i].parentId).toBe(rows[i - 1].id);
    expect(new Set(rows.map((r) => r.sessionId))).toEqual(new Set([sessionBefore.id]));
    for (const row of rows.slice(0, 3)) {
      expect(row.rotatedAt).toEqual(expect.any(Date));
      expect(await prisma.refreshToken.count({ where: { parentId: row.id } })).toBe(1);
    }
    expect(rows[3]).toEqual(expect.objectContaining({ rotatedAt: null, revokedAt: null }));
    expect(await prisma.refreshToken.count({ where: { parentId: rows[3].id } })).toBe(0);

    const sessionAfter = await prisma.authSession.findFirstOrThrow();
    expect(sessionAfter.absoluteExpiresAt).toEqual(sessionBefore.absoluteExpiresAt);
    expect(sessionAfter.lastUsedAt.getTime()).toBeGreaterThanOrEqual(sessionBefore.lastUsedAt.getTime());
  });

  describe('TEST 3 — absolute session lifetime (90 days)', () => {
    it('refreshing every 29 days keeps a session alive only until day 90 after sign-in', async () => {
      const t0 = Date.now();
      setNow(t0);
      let { refreshToken } = await signIn();
      for (const day of [29, 58, 87, 89]) {
        setNow(t0 + day * DAY);
        ({ refreshToken } = await refresh(refreshToken));
      }
      const session = await prisma.authSession.findFirstOrThrow();
      expect(session.absoluteExpiresAt.getTime()).toBe(t0 + 90 * DAY);

      setNow(t0 + 90 * DAY + 1000);
      await expect(refresh(refreshToken)).rejects.toThrow(UnauthorizedException);
      expect(await prisma.refreshToken.count({ where: { parentId: (await tokenRow(refreshToken)).id } })).toBe(0);
    });

    it("the session's own expiry is enforced even when the token itself has not expired", async () => {
      const { refreshToken } = await signIn();
      const row = await tokenRow(refreshToken);
      await prisma.refreshToken.update({ where: { id: row.id }, data: { expiresAt: new Date(Date.now() + 365 * DAY) } });
      await prisma.authSession.update({
        where: { id: row.sessionId! },
        data: { absoluteExpiresAt: new Date(Date.now() - 1000) },
      });

      await expect(refresh(refreshToken)).rejects.toThrow('Invalid or expired refresh token');
      expect(await tokenRow(refreshToken)).toEqual(expect.objectContaining({ rotatedAt: null, revokedAt: null }));
    });
  });

  it('TEST 4 — with 2 hours of session left, the new token expires with the session, not 30 days later', async () => {
    const { refreshToken } = await signIn();
    const row = await tokenRow(refreshToken);
    const absoluteExpiresAt = new Date(Date.now() + 2 * 60 * 60 * 1000);
    await prisma.authSession.update({ where: { id: row.sessionId! }, data: { absoluteExpiresAt } });

    const next = await refresh(refreshToken);
    const successor = await tokenRow(next.refreshToken);
    expect(successor.expiresAt.getTime()).toBe(absoluteExpiresAt.getTime());
    expect((await prisma.authSession.findUniqueOrThrow({ where: { id: row.sessionId! } })).absoluteExpiresAt).toEqual(
      absoluteExpiresAt,
    );
  });

  describe('TEST 5 — logout', () => {
    it('revokes the whole session with the refresh token alone; the response is the same for any token', async () => {
      const { user, refreshToken } = await signIn();
      const { refreshToken: current } = await refresh(refreshToken);

      await expect(auth.logout(current)).resolves.toEqual({ success: true });
      const session = await prisma.authSession.findFirstOrThrow();
      expect(session).toEqual(
        expect.objectContaining({ revokedAt: expect.any(Date), revokedReason: SessionRevokedReason.LOGOUT }),
      );
      expect(await prisma.refreshToken.count({ where: { sessionId: session.id, revokedAt: null } })).toBe(0);
      await expect(refresh(current)).rejects.toThrow(UnauthorizedException);

      // Already revoked, unknown, rotated: identical answer, nothing changes.
      for (const token of [current, 'f'.repeat(96), refreshToken]) {
        await expect(auth.logout(token)).resolves.toEqual({ success: true });
      }
      const audit = await prisma.auditLog.findMany({ where: { entityType: 'AuthSession' } });
      expect(audit).toHaveLength(1);
      expect(audit[0]).toEqual(
        expect.objectContaining({
          actorId: user.id,
          entityId: session.id,
          after: { revoked: true, reason: 'LOGOUT', tokensRevoked: 1 },
        }),
      );
    });

    it('logout racing a refresh of the same token: the session ends revoked with no live token in it', async () => {
      for (let round = 0; round < 5; round++) {
        const { refreshToken } = await signIn();
        const r1 = await tokenRow(refreshToken);
        await raceAtSessionLock(prisma, r1.sessionId!, 2, () =>
          Promise.allSettled([refresh(refreshToken), auth.logout(refreshToken)]),
        );
        const session = await prisma.authSession.findUniqueOrThrow({ where: { id: r1.sessionId! } });
        expect(session.revokedReason).toBe(SessionRevokedReason.LOGOUT);
        expect(await prisma.refreshToken.count({ where: { sessionId: session.id, revokedAt: null } })).toBe(0);
      }
    });
  });

  describe('TEST 6 — password reset', () => {
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

    it('revokes every session and token of the user and bumps sessionVersion; nothing comes back', async () => {
      const a = await signIn();
      const b = await auth.login({ phone: a.user.phone, password: PASSWORD });
      await issueResetCode(a.user.phone);

      await auth.resetPassword({ phone: a.user.phone, code: '135790', newPassword: 'brand-new-password' });

      const user = await prisma.user.findUniqueOrThrow({ where: { id: a.user.id } });
      expect(user.sessionVersion).toBe(a.user.sessionVersion + 1);
      const sessions = await prisma.authSession.findMany({ where: { userId: user.id } });
      expect(sessions).toHaveLength(2);
      expect(sessions.every((s) => s.revokedReason === SessionRevokedReason.PASSWORD_RESET && s.revokedAt)).toBe(true);
      expect(await prisma.refreshToken.count({ where: { userId: user.id, revokedAt: null } })).toBe(0);
      for (const token of [a.refreshToken, b.refreshToken]) await expect(refresh(token)).rejects.toThrow(UnauthorizedException);

      const fresh = await auth.login({ phone: user.phone, password: 'brand-new-password' });
      await expect(refresh(fresh.refreshToken)).resolves.toBeDefined();
      expect(await prisma.authSession.count({ where: { userId: user.id, revokedAt: null } })).toBe(1);
    });

    it('a reset racing a refresh (both held at the session lock): no live token survives the reset', async () => {
      for (let round = 0; round < 5; round++) {
        const { user, refreshToken } = await signIn();
        const r1 = await tokenRow(refreshToken);
        await issueResetCode(user.phone);
        await raceAtSessionLock(prisma, r1.sessionId!, 2, () =>
          Promise.allSettled([
            refresh(refreshToken),
            auth.resetPassword({ phone: user.phone, code: '135790', newPassword: 'brand-new-password' }),
          ]),
        );
        expect(await prisma.refreshToken.count({ where: { userId: user.id, revokedAt: null } })).toBe(0);
        expect(await prisma.authSession.count({ where: { userId: user.id, revokedAt: null } })).toBe(0);
      }
    });
  });

  it('TEST 7 — suspension revokes every session; reinstatement revives none', async () => {
    const actor = await createUser(prisma, nextPhone(), UserRole.SUPER_ADMIN);
    const a = await signIn();
    const b = await auth.login({ phone: a.user.phone, password: PASSWORD });
    const staff = { id: actor.id, phone: actor.phone, role: UserRole.SUPER_ADMIN };

    await admin.suspendUser(a.user.id, staff, 'Fraud report');
    const suspended = await prisma.user.findUniqueOrThrow({ where: { id: a.user.id } });
    expect(suspended.status).toBe(UserStatus.SUSPENDED);
    expect(suspended.sessionVersion).toBe(a.user.sessionVersion + 1);
    const sessions = await prisma.authSession.findMany({ where: { userId: a.user.id } });
    expect(sessions).toHaveLength(2);
    expect(sessions.every((s) => s.revokedReason === SessionRevokedReason.SUSPENDED)).toBe(true);
    expect(await prisma.refreshToken.count({ where: { userId: a.user.id, revokedAt: null } })).toBe(0);

    await admin.activateUser(a.user.id, staff, 'Cleared');
    for (const token of [a.refreshToken, b.refreshToken]) await expect(refresh(token)).rejects.toThrow(UnauthorizedException);
    expect(await prisma.authSession.count({ where: { userId: a.user.id, revokedAt: null } })).toBe(0);

    const fresh = await auth.login({ phone: a.user.phone, password: PASSWORD });
    await expect(refresh(fresh.refreshToken)).resolves.toBeDefined();
  });

  it('TEST 8 — two devices: signing out of A leaves B working', async () => {
    const a = await signIn();
    const b = await auth.login({ phone: a.user.phone, password: PASSWORD });

    await auth.logout(a.refreshToken);

    await expect(refresh(a.refreshToken)).rejects.toThrow(UnauthorizedException);
    const next = await refresh(b.refreshToken);
    await expect(refresh(next.refreshToken)).resolves.toBeDefined();
    const sessionB = (await tokenRow(b.refreshToken)).sessionId!;
    expect((await prisma.authSession.findUniqueOrThrow({ where: { id: sessionB } })).revokedAt).toBeNull();
  });

  it('TEST 9 — an already-rotated token: generic 401, no successor, no session revocation; grace data is queryable', async () => {
    const { refreshToken: r1Raw } = await signIn();
    const { refreshToken: r2Raw } = await refresh(r1Raw);
    const before = await prisma.refreshToken.count();

    await expect(refresh(r1Raw)).rejects.toThrow('Invalid or expired refresh token');

    expect(await prisma.refreshToken.count()).toBe(before);
    const r1 = await tokenRow(r1Raw);
    const session = await prisma.authSession.findUniqueOrThrow({ where: { id: r1.sessionId! } });
    expect(session.revokedAt).toBeNull(); // inside the grace window, successor unused: a harmless race, not reuse (15E.4c)

    // The grace-window inputs: when R1 was rotated, and whether its successor was used.
    const successor = await prisma.refreshToken.findUniqueOrThrow({ where: { parentId: r1.id } });
    expect(successor.tokenHash).toBe(sha256(r2Raw));
    expect(isWithinRefreshGraceWindow(r1, successor, new Date())).toBe(true);
    expect(isWithinRefreshGraceWindow(r1, successor, new Date(r1.rotatedAt!.getTime() + REFRESH_GRACE_WINDOW_MS + 1))).toBe(
      false,
    );

    await refresh(r2Raw); // the successor is now used
    const usedSuccessor = await prisma.refreshToken.findUniqueOrThrow({ where: { parentId: r1.id } });
    expect(isWithinRefreshGraceWindow(r1, usedSuccessor, new Date())).toBe(false);
  });

  it('TEST 10 — the database itself refuses a second successor of the same token (parent_id UNIQUE)', async () => {
    const { user, refreshToken } = await signIn();
    const parent = await tokenRow(refreshToken);
    const successor = (n: number) => ({
      userId: user.id,
      sessionId: parent.sessionId,
      parentId: parent.id,
      tokenHash: sha256(`direct-successor-${n}`),
      expiresAt: new Date(Date.now() + DAY),
    });

    await prisma.refreshToken.create({ data: successor(1) });
    const error = await prisma.refreshToken.create({ data: successor(2) }).catch((e) => e);
    expect(error).toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
    expect(error.code).toBe('P2002');
    expect(error.meta?.target).toEqual(['parent_id']);
    expect(await prisma.refreshToken.count({ where: { parentId: parent.id } })).toBe(1);
  });

  describe('TEST 11 — a failed rotation commits nothing', () => {
    it('successor insert fails (conflicting successor already present): predecessor and session untouched', async () => {
      const { user, refreshToken } = await signIn();
      const r1 = await tokenRow(refreshToken);
      const sessionBefore = await prisma.authSession.findUniqueOrThrow({ where: { id: r1.sessionId! } });
      // A row already claiming to be R1's successor makes the rotation's INSERT
      // fail AFTER the session lock and the compare-and-set have both run.
      await prisma.refreshToken.create({
        data: {
          userId: user.id,
          sessionId: r1.sessionId,
          parentId: r1.id,
          tokenHash: sha256('conflicting-successor'),
          expiresAt: new Date(Date.now() + DAY),
        },
      });

      await expect(refresh(refreshToken)).rejects.toThrow('Invalid or expired refresh token');

      expect(await tokenRow(refreshToken)).toEqual(expect.objectContaining({ rotatedAt: null, revokedAt: null }));
      expect(await prisma.authSession.findUniqueOrThrow({ where: { id: r1.sessionId! } })).toEqual(sessionBefore);
      expect(await prisma.refreshToken.count()).toBe(2);
    });

    it('account no longer active at rotation time: the rotation is rolled back', async () => {
      const { user, refreshToken } = await signIn();
      await prisma.user.update({ where: { id: user.id }, data: { status: UserStatus.SUSPENDED } });

      await expect(refresh(refreshToken)).rejects.toThrow(UnauthorizedException);
      expect(await tokenRow(refreshToken)).toEqual(expect.objectContaining({ rotatedAt: null, revokedAt: null }));
      expect(await prisma.refreshToken.count()).toBe(1);
    });
  });

  it('TEST 12 — no raw refresh token reaches a log line, a query parameter or any stored column', async () => {
    const logged = createTestPrisma(true);
    const params: string[] = [];
    (logged as unknown as { $on: (e: 'query', cb: (ev: Prisma.QueryEvent) => void) => void }).$on('query', (ev) =>
      params.push(ev.params),
    );
    const output: string[] = [];
    const capture = (stream: NodeJS.WriteStream) =>
      jest.spyOn(stream, 'write').mockImplementation((chunk: string | Uint8Array) => (output.push(String(chunk)), true));
    const spies: jest.SpyInstance[] = [capture(process.stdout), capture(process.stderr)];
    for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) {
      spies.push(
        jest.spyOn(console, level).mockImplementation((...args: unknown[]) => void output.push(args.map(String).join(' '))),
      );
    }

    const raws: string[] = [];
    try {
      const { auth: loggedAuth } = services(logged);
      const user = await createUser(logged, nextPhone());
      const first = await loggedAuth.login({ phone: user.phone, password: PASSWORD });
      raws.push(first.refreshToken);
      const second = await loggedAuth.refresh({ refreshToken: first.refreshToken });
      raws.push(second.refreshToken);
      await loggedAuth.refresh({ refreshToken: first.refreshToken }).catch(() => undefined); // rotated: refused
      await loggedAuth.logout(second.refreshToken);
    } finally {
      spies.forEach((spy) => spy.mockRestore());
      await logged.$disconnect();
    }

    const stored = await prisma.$queryRaw<Array<{ row: string }>>`
      SELECT row_to_json(t)::text AS row FROM refresh_tokens t
      UNION ALL SELECT row_to_json(s)::text FROM auth_sessions s
      UNION ALL SELECT row_to_json(a)::text FROM audit_logs a`;
    const everything = [...params, ...output, ...stored.map((r) => r.row)].join('\n');
    expect(params.length).toBeGreaterThan(0);
    for (const raw of raws) {
      expect(/^[0-9a-f]{96}$/.test(raw)).toBe(true);
      expect(everything.includes(raw)).toBe(false);
    }
    expect(everything.includes(sha256(raws[0]))).toBe(true); // only the hash is ever stored or sent
  });

  describe('TEST 13 — the session contract (Phase 15E.4e.1) and rolling-deploy compatibility', () => {
    it('rotation stamps revoked_at with rotated_at, so a rotated token fails every plain "revoked_at IS NULL" check', async () => {
      const { refreshToken } = await signIn();
      await refresh(refreshToken);
      const row = await tokenRow(refreshToken);
      expect(row.rotatedAt).toEqual(expect.any(Date));
      expect(row.revokedAt).toEqual(row.rotatedAt);
      expect(await prisma.refreshToken.count({ where: { id: row.id, revokedAt: null } })).toBe(0);
    });

    it('the database refuses a refresh token without a session (session_id NOT NULL)', async () => {
      const user = await createUser(prisma, nextPhone());
      const [{ is_nullable }] = await prisma.$queryRaw<Array<{ is_nullable: string }>>`
        SELECT is_nullable FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'refresh_tokens' AND column_name = 'session_id'`;
      expect(is_nullable).toBe('NO');

      // Exactly the INSERT the pre-15E.4b release issued — no session_id.
      const error = await prisma
        .$executeRaw`INSERT INTO refresh_tokens (user_id, token_hash, expires_at) VALUES (${user.id}, ${sha256('no-session')}, now() + interval '1 day')`
        .catch((e) => e);
      expect(String(error?.message ?? error)).toMatch(/23502|null value in column "session_id"/);
      expect(await prisma.refreshToken.count({ where: { userId: user.id } })).toBe(0);
    });

    it("the previous release's (06d6de9) session-less statements still run, matching nothing, on the contracted schema", async () => {
      // While 15E.4e.1 deploys, 06d6de9 keeps serving. Its legacy sweep in
      // revokeAllUserSessions and its lazy-attach probe filter on
      // session_id IS NULL — valid on a NOT NULL column, and now always empty.
      const { user, refreshToken } = await signIn();
      const swept = await prisma.$executeRaw`
        UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = ${user.id} AND session_id IS NULL AND revoked_at IS NULL`;
      expect(swept).toBe(0);
      const [{ sessionless }] = await prisma.$queryRaw<Array<{ sessionless: number }>>`
        SELECT count(*)::int AS sessionless FROM refresh_tokens WHERE session_id IS NULL`;
      expect(sessionless).toBe(0);
      await expect(refresh(refreshToken)).resolves.toBeDefined(); // the token is untouched
    });
  });

  describe('R1 — logout racing a refresh of the same session (grace-window logout)', () => {
    const DAY_MS = 24 * 60 * 60 * 1000;
    const liveTokens = (where: Prisma.RefreshTokenWhereInput) =>
      prisma.refreshToken.count({ where: { ...where, revokedAt: null } });

    it('normal logout with the current token revokes the session', async () => {
      const { refreshToken } = await signIn();
      await expect(auth.logout(refreshToken)).resolves.toEqual({ success: true });
      const session = await prisma.authSession.findFirstOrThrow();
      expect(session.revokedReason).toBe(SessionRevokedReason.LOGOUT);
      expect(await liveTokens({ sessionId: session.id })).toBe(0);
    });

    it('the refresh already committed but its response never reached the client: logout with the rotated token ends the session', async () => {
      const { refreshToken: r1 } = await signIn();
      const { refreshToken: r2 } = await refresh(r1); // the client never stores this — it is discarding it

      await expect(auth.logout(r1)).resolves.toEqual({ success: true });

      const session = await prisma.authSession.findFirstOrThrow();
      expect(session.revokedReason).toBe(SessionRevokedReason.LOGOUT);
      expect(await liveTokens({ sessionId: session.id })).toBe(0);
      await expect(refresh(r2)).rejects.toThrow('Invalid or expired refresh token');
      const audit = await prisma.auditLog.findMany({ where: { entityType: 'AuthSession' } });
      expect(audit).toHaveLength(1);
      expect(audit[0].after).toEqual({ revoked: true, reason: 'LOGOUT', tokensRevoked: 1 });
    });

    it('logout arrives while the refresh is mid-transaction (forced): no live successor, session revoked', async () => {
      const { user, refreshToken: r1 } = await signIn();
      const row = await tokenRow(r1);
      let outcome!: Promise<PromiseSettledResult<unknown>[]>;

      // An uncommitted placeholder with parent_id = R1 makes the refresh stop
      // at its successor INSERT — after it took the session lock and rotated R1.
      await inRolledBackTransaction(prisma, async (tx) => {
        await tx.refreshToken.create({
          data: {
            userId: user.id,
            sessionId: row.sessionId,
            parentId: row.id,
            tokenHash: sha256('placeholder-r1'),
            expiresAt: new Date(Date.now() + DAY_MS),
          },
        });
        const refreshing = refresh(r1);
        await waitForLockWaiters(prisma, 'refresh_tokens', 1);
        const loggingOut = auth.logout(r1); // still reads R1 as current; then waits on the session lock
        await waitForLockWaiters(prisma, 'auth_sessions', 1);
        outcome = Promise.allSettled([refreshing, loggingOut]);
      });
      const [refreshed, loggedOut] = await outcome;

      expect(refreshed.status).toBe('fulfilled'); // the refresh committed first...
      expect(loggedOut).toEqual({ status: 'fulfilled', value: { success: true } });
      const session = await prisma.authSession.findUniqueOrThrow({ where: { id: row.sessionId! } });
      expect(session.revokedReason).toBe(SessionRevokedReason.LOGOUT); // ...and logout still ended its session
      expect(await liveTokens({ userId: user.id })).toBe(0);
      const successor = (refreshed as PromiseFulfilledResult<{ refreshToken: string }>).value.refreshToken;
      await expect(refresh(successor)).rejects.toThrow(UnauthorizedException);
    });

    it('unsynchronised refresh + logout of one token, 20 rounds: the session always ends revoked with no live token', async () => {
      for (let round = 0; round < 20; round++) {
        const { user, refreshToken } = await signIn();
        await Promise.allSettled([refresh(refreshToken), auth.logout(refreshToken)]);
        expect(await liveTokens({ userId: user.id })).toBe(0);
        expect(await prisma.authSession.count({ where: { userId: user.id, revokedAt: null } })).toBe(0);
      }
    });

    it('logout with a rotated token whose successor was already used ends nothing; refresh with it is reuse (15E.4c)', async () => {
      const { refreshToken: r1 } = await signIn();
      const { refreshToken: r2 } = await refresh(r1);
      const { refreshToken: r3 } = await refresh(r2); // the successor of R1 is used

      await expect(auth.logout(r1)).resolves.toEqual({ success: true });

      const session = await prisma.authSession.findFirstOrThrow();
      expect(session.revokedAt).toBeNull(); // stale-token logout stays a no-op
      expect(await prisma.auditLog.count({ where: { entityType: 'AuthSession' } })).toBe(0);
      await expect(refresh(r3)).resolves.toBeDefined();

      // The same stale token at /auth/refresh: generic 401, and this session is revoked for reuse.
      await expect(refresh(r1)).rejects.toThrow('Invalid or expired refresh token');
      expect((await prisma.authSession.findFirstOrThrow()).revokedReason).toBe(SessionRevokedReason.REUSE_DETECTED);
    });

    it("a rotation stamped slightly ahead of logout's clock (another request's or replica's clock) still counts as recent", async () => {
      const { refreshToken: r1 } = await signIn();
      await refresh(r1);
      const r1Row = await tokenRow(r1);
      await prisma.refreshToken.update({ where: { id: r1Row.id }, data: { rotatedAt: new Date(Date.now() + 2000) } });

      await expect(auth.logout(r1)).resolves.toEqual({ success: true });

      expect((await prisma.authSession.findFirstOrThrow()).revokedReason).toBe(SessionRevokedReason.LOGOUT);
      expect(await liveTokens({ sessionId: r1Row.sessionId })).toBe(0);
    });

    it('a rotation stamped further in the future than the clock-skew tolerance ends nothing', async () => {
      const { refreshToken: r1 } = await signIn();
      const { refreshToken: r2 } = await refresh(r1);
      const r1Row = await tokenRow(r1);
      await prisma.refreshToken.update({
        where: { id: r1Row.id },
        data: { rotatedAt: new Date(Date.now() + MAX_CLOCK_SKEW_MS + 60_000) },
      });

      await expect(auth.logout(r1)).resolves.toEqual({ success: true });

      expect((await prisma.authSession.findFirstOrThrow()).revokedAt).toBeNull();
      await expect(refresh(r2)).resolves.toBeDefined();
    });

    it('a rotated token outside the grace window ends nothing, even with its successor unused', async () => {
      const t0 = Date.now();
      setNow(t0);
      const { refreshToken: r1 } = await signIn();
      const { refreshToken: r2 } = await refresh(r1);

      setNow(t0 + REFRESH_GRACE_WINDOW_MS + 1000);
      await expect(auth.logout(r1)).resolves.toEqual({ success: true });

      expect((await prisma.authSession.findFirstOrThrow()).revokedAt).toBeNull();
      await expect(refresh(r2)).resolves.toBeDefined();
    });

    it('entitlement is decided under the session lock: successor used while logout waited → logout rolls back', async () => {
      const { refreshToken: r1 } = await signIn();
      const { refreshToken: r2 } = await refresh(r1);
      const r2Row = await tokenRow(r2);
      let loggingOut!: Promise<unknown>;

      await prisma.$transaction(
        async (tx) => {
          await tx.$queryRaw`SELECT id FROM auth_sessions WHERE id = ${r2Row.sessionId} FOR UPDATE`;
          loggingOut = auth.logout(r1); // R1 is entitled now (R2 unused) — then waits on the lock
          await waitForLockWaiters(prisma, 'auth_sessions', 1);
          // While it waits, the successor gets used (as a refresh of R2 would).
          await tx.refreshToken.update({ where: { id: r2Row.id }, data: { rotatedAt: new Date() } });
        },
        { timeout: 20_000 },
      );
      await expect(loggingOut).resolves.toEqual({ success: true });

      const session = await prisma.authSession.findUniqueOrThrow({ where: { id: r2Row.sessionId! } });
      expect(session.revokedAt).toBeNull(); // the revocation it had started was rolled back
      expect(await prisma.auditLog.count({ where: { entityType: 'AuthSession' } })).toBe(0);
    });

  });
});
