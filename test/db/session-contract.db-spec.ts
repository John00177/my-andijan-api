import { OtpPurpose, PrismaClient, SessionRevokedReason, UserRole } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import { createHash } from 'crypto';
import { AdminService } from '../../src/admin/admin.service';
import { AuthService } from '../../src/auth/auth.service';
import { REFRESH_GRACE_WINDOW_MS } from '../../src/auth/refresh-sessions';
import { createTestPrisma, createUser, PASSWORD, resetDatabase, services } from './support';

// Phase 15E.4e.1 — the final refresh-token/session contract, checked on REAL
// PostgreSQL after a realistic mix of every flow that writes sessions or
// tokens: password login, registration, SMS-code sign-in, rotation (also
// concurrent), a harmless grace-window race, reuse, logout, password reset
// and suspension, across two users and several devices. Afterwards every
// contract invariant is asserted directly in the database.

const sha256 = (raw: string) => createHash('sha256').update(raw).digest('hex');

/** Every count here must be 0 for the contract to hold (the same checks as the 15E.4e evidence queries). */
const INVARIANTS: Record<string, string> = {
  'C1/C2 a token without a session': `SELECT count(*)::int AS n FROM refresh_tokens WHERE session_id IS NULL`,
  'C4 a successor in another session than its parent': `
    SELECT count(*)::int AS n FROM refresh_tokens c JOIN refresh_tokens p ON p.id = c.parent_id
    WHERE c.session_id IS DISTINCT FROM p.session_id`,
  'C4 a successor of another user than its parent': `
    SELECT count(*)::int AS n FROM refresh_tokens c JOIN refresh_tokens p ON p.id = c.parent_id WHERE c.user_id <> p.user_id`,
  'C4 a parent with a successor but never rotated': `
    SELECT count(*)::int AS n FROM refresh_tokens c JOIN refresh_tokens p ON p.id = c.parent_id WHERE p.rotated_at IS NULL`,
  'C5 more than one successor of one parent': `
    SELECT count(*)::int AS n FROM (SELECT parent_id FROM refresh_tokens WHERE parent_id IS NOT NULL
                                    GROUP BY parent_id HAVING count(*) > 1) x`,
  'C6 a rotated token that is not revoked': `
    SELECT count(*)::int AS n FROM refresh_tokens WHERE rotated_at IS NOT NULL AND revoked_at IS NULL`,
  'cross-user: a token in another user’s session': `
    SELECT count(*)::int AS n FROM refresh_tokens t JOIN auth_sessions s ON s.id = t.session_id WHERE t.user_id <> s.user_id`,
  'C9 a live token in a revoked or expired session': `
    SELECT count(*)::int AS n FROM refresh_tokens t JOIN auth_sessions s ON s.id = t.session_id
    WHERE t.revoked_at IS NULL AND t.expires_at > (now() AT TIME ZONE 'UTC')
      AND (s.revoked_at IS NOT NULL OR s.absolute_expires_at <= (now() AT TIME ZONE 'UTC'))`,
  'C13 a token outliving its session': `
    SELECT count(*)::int AS n FROM refresh_tokens t JOIN auth_sessions s ON s.id = t.session_id
    WHERE t.expires_at > s.absolute_expires_at`,
  'more than one usable token in one session': `
    SELECT count(*)::int AS n FROM (SELECT session_id FROM refresh_tokens WHERE revoked_at IS NULL
                                    GROUP BY session_id HAVING count(*) > 1) x`,
  'C3 a session with no token': `
    SELECT count(*)::int AS n FROM auth_sessions s WHERE NOT EXISTS (SELECT 1 FROM refresh_tokens t WHERE t.session_id = s.id)`,
  'C3 a session with more than one root token': `
    SELECT count(*)::int AS n FROM (SELECT session_id FROM refresh_tokens WHERE parent_id IS NULL
                                    GROUP BY session_id HAVING count(*) > 1) x`,
  'revoked_at and revoked_reason disagree': `
    SELECT count(*)::int AS n FROM auth_sessions WHERE (revoked_at IS NULL) <> (revoked_reason IS NULL)`,
};

describe('Refresh-token / session contract on PostgreSQL (Phase 15E.4e.1)', () => {
  let prisma: PrismaClient;
  let auth: AuthService;
  let admin: AdminService;
  let phoneSeq = 0;
  const nextPhone = () => `+99891${String(1000000 + ++phoneSeq).slice(-7)}`;

  beforeAll(async () => {
    prisma = createTestPrisma();
    await prisma.$connect();
    ({ auth, admin } = services(prisma));
  });
  afterAll(() => prisma.$disconnect());
  beforeEach(() => resetDatabase(prisma));

  async function violations(): Promise<Record<string, number>> {
    const found: Record<string, number> = {};
    for (const [name, sql] of Object.entries(INVARIANTS)) {
      const [{ n }] = await prisma.$queryRawUnsafe<Array<{ n: number }>>(sql);
      if (n !== 0) found[name] = n;
    }
    return found;
  }

  const rotatedAgo = (raw: string, ms: number) =>
    prisma.refreshToken.update({ where: { tokenHash: sha256(raw) }, data: { rotatedAt: new Date(Date.now() - ms) } });

  it('every invariant holds after password login, registration, SMS-code sign-in, rotation, races, reuse, logout, reset and suspension', async () => {
    // Sign-ins: each creates exactly one session with exactly one root token.
    const alice = await createUser(prisma, nextPhone());
    const aLaptop = await auth.login({ phone: alice.phone, password: PASSWORD });
    const aPhone = await auth.login({ phone: alice.phone, password: PASSWORD });
    const bob = await auth.register({ phone: nextPhone(), password: PASSWORD, fullName: 'Bob' });
    const carolPhone = nextPhone();
    await prisma.otpCode.create({
      data: {
        phone: carolPhone,
        purpose: OtpPurpose.LOGIN,
        codeHash: await bcrypt.hash('246810', 4),
        expiresAt: new Date(Date.now() + 5 * 60_000),
      },
    });
    const carol = await auth.verifyOtp({ phone: carolPhone, otp: '246810' });
    expect(await prisma.authSession.count()).toBe(4);
    expect(await prisma.refreshToken.count()).toBe(4);
    expect(await violations()).toEqual({});

    // Rotation chains, and a concurrent burst: exactly one successor.
    const a2 = await auth.refresh({ refreshToken: aLaptop.refreshToken });
    const a3 = await auth.refresh({ refreshToken: a2.refreshToken });
    const burst = await Promise.allSettled(Array.from({ length: 8 }, () => auth.refresh({ refreshToken: bob.refreshToken })));
    expect(burst.filter((r) => r.status === 'fulfilled')).toHaveLength(1);

    // A harmless grace-window race: refused, the session stays live.
    const c2 = await auth.refresh({ refreshToken: carol.refreshToken });
    await expect(auth.refresh({ refreshToken: carol.refreshToken })).rejects.toThrow();
    expect((await prisma.authSession.findFirstOrThrow({ where: { userId: carol.user.id } })).revokedAt).toBeNull();
    await expect(auth.refresh({ refreshToken: c2.refreshToken })).resolves.toBeDefined();

    // Genuine reuse (outside the window): that one session is revoked.
    await rotatedAgo(aLaptop.refreshToken, REFRESH_GRACE_WINDOW_MS + 60_000);
    await expect(auth.refresh({ refreshToken: aLaptop.refreshToken })).rejects.toThrow();
    const laptopSession = await prisma.refreshToken.findUniqueOrThrow({
      where: { tokenHash: sha256(a3.refreshToken) },
      select: { session: { select: { revokedReason: true } } },
    });
    expect(laptopSession.session.revokedReason).toBe(SessionRevokedReason.REUSE_DETECTED);
    // ...and only that one: Alice's phone still works.
    const aPhone2 = await auth.refresh({ refreshToken: aPhone.refreshToken });

    // Logout ends one session.
    await expect(auth.logout(aPhone2.refreshToken)).resolves.toEqual({ success: true });

    // Password reset (Bob) and suspension (Carol): user-wide.
    const bobLaptop = await auth.login({ phone: bob.user.phone, password: PASSWORD });
    await prisma.otpCode.create({
      data: {
        phone: bob.user.phone,
        purpose: OtpPurpose.PASSWORD_RESET,
        codeHash: await bcrypt.hash('135790', 4),
        expiresAt: new Date(Date.now() + 10 * 60_000),
      },
    });
    await auth.resetPassword({ phone: bob.user.phone, code: '135790', newPassword: 'brand-new-password' });
    await expect(auth.refresh({ refreshToken: bobLaptop.refreshToken })).rejects.toThrow();
    expect(await prisma.authSession.count({ where: { userId: bob.user.id, revokedAt: null } })).toBe(0);

    const staffUser = await createUser(prisma, nextPhone(), UserRole.SUPER_ADMIN);
    await admin.suspendUser(carol.user.id, { id: staffUser.id, phone: staffUser.phone, role: UserRole.SUPER_ADMIN }, 'Fraud');
    expect(await prisma.authSession.count({ where: { userId: carol.user.id, revokedAt: null } })).toBe(0);
    expect(await prisma.refreshToken.count({ where: { userId: carol.user.id, revokedAt: null } })).toBe(0);

    // The contract holds for everything those flows wrote.
    expect(await violations()).toEqual({});
    expect(await prisma.authSession.count({ where: { revokedReason: SessionRevokedReason.REUSE_DETECTED } })).toBe(1);
    expect(await prisma.authSession.count({ where: { revokedReason: SessionRevokedReason.LOGOUT } })).toBe(1);
  });

  it('the invariant checks themselves detect a violation (a cross-user token is reported)', async () => {
    // Guards the guard: if these queries could not fail, the test above would prove nothing.
    const alice = await createUser(prisma, nextPhone());
    const bob = await createUser(prisma, nextPhone());
    await auth.login({ phone: alice.phone, password: PASSWORD });
    const bobSession = await auth.login({ phone: bob.phone, password: PASSWORD });
    const bobToken = await prisma.refreshToken.findUniqueOrThrow({ where: { tokenHash: sha256(bobSession.refreshToken) } });
    const aliceSession = await prisma.authSession.findFirstOrThrow({ where: { userId: alice.id } });
    await prisma.refreshToken.update({ where: { id: bobToken.id }, data: { sessionId: aliceSession.id } });

    const found = await violations();
    expect(found['cross-user: a token in another user’s session']).toBe(1);
  });
});
