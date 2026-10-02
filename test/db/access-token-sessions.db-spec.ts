import { Controller, Get, INestApplication } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { Test } from '@nestjs/testing';
import { OtpPurpose, PrismaClient, SessionRevokedReason, UserRole, UserStatus } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import { createHash } from 'crypto';
import { AddressInfo } from 'node:net';
import { AuthService } from '../../src/auth/auth.service';
import { AdminService } from '../../src/admin/admin.service';
import { AuthenticatedUser, JwtPayload, JwtStrategy } from '../../src/auth/strategies/jwt.strategy';
import { AuthzGuard } from '../../src/authz/authz.guard';
import { Authenticated } from '../../src/authz/authz.decorators';
import { CurrentUser } from '../../src/common/decorators/current-user.decorator';
import { PrismaService } from '../../src/prisma/prisma.service';
import { createTestPrisma, createUser, PASSWORD, resetDatabase, services } from './support';

// Phase 15E.4d — access tokens bound to their AuthSession (`sid`), over real
// HTTP through the real global AuthzGuard and passport JwtStrategy, on real
// PostgreSQL. Since 15E.4d.2 `sid` is mandatory: the 15E.4d.1 compatibility
// path for tokens without it is gone.

@Controller('probe')
class ProbeController {
  @Authenticated()
  @Get()
  me(@CurrentUser() user: AuthenticatedUser) {
    return { id: user.id };
  }
}

const GENERIC_401 = { message: 'Unauthorized', statusCode: 401 };
const sha256 = (raw: string) => createHash('sha256').update(raw).digest('hex');

describe('Access-token session binding on PostgreSQL (Phase 15E.4d.1 + 15E.4d.2)', () => {
  let prisma: PrismaClient;
  let auth: AuthService;
  let admin: AdminService;
  let app: INestApplication;
  let base: string;
  const jwt = new JwtService({});
  let phoneSeq = 0;
  const nextPhone = () => `+99893${String(1000000 + ++phoneSeq).slice(-7)}`;

  const claims = (token: string) => jwt.decode(token) as JwtPayload & { exp: number; iat: number };
  const sessionIdOf = async (refreshToken: string) =>
    (await prisma.refreshToken.findUniqueOrThrow({ where: { tokenHash: sha256(refreshToken) } })).sessionId!;
  const sign = (payload: object, secret = process.env.JWT_ACCESS_SECRET!) => jwt.signAsync(payload, { secret });

  async function probe(token?: string): Promise<{ status: number; body: unknown; text: string }> {
    const res = await fetch(`${base}/probe`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null, text };
  }

  async function expectRefused(token: string) {
    const res = await probe(token);
    expect(res.status).toBe(401);
    expect(res.body).toEqual(GENERIC_401);
    // Nothing about the token, its session or why it failed is disclosed.
    expect(res.text.includes(token)).toBe(false);
    expect(/sid|session|revoked|expired|inactive/i.test(res.text)).toBe(false);
  }

  async function signIn() {
    const user = await createUser(prisma, nextPhone());
    const session = await auth.login({ phone: user.phone, password: PASSWORD });
    return { ...session, user };
  }

  beforeAll(async () => {
    prisma = createTestPrisma();
    await prisma.$connect();
    ({ auth, admin } = services(prisma)); // also sets JWT_ACCESS_SECRET for the strategy
    const moduleRef = await Test.createTestingModule({
      imports: [PassportModule.register({ defaultStrategy: 'jwt' })],
      controllers: [ProbeController],
      providers: [
        JwtStrategy,
        { provide: PrismaService, useValue: prisma },
        { provide: APP_GUARD, useClass: AuthzGuard },
      ],
    }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    await app.listen(0, '127.0.0.1');
    base = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    await app?.close();
    await prisma.$disconnect();
  });
  beforeEach(() => resetDatabase(prisma));

  describe('issuance: every new access token names its session', () => {
    it('1 & 2. login issues sid = the new session; refresh keeps the same sid', async () => {
      const { refreshToken, accessToken } = await signIn();
      const sessionId = await sessionIdOf(refreshToken);
      expect(claims(accessToken).sid).toBe(sessionId);

      const next = await auth.refresh({ refreshToken });
      expect(claims(next.accessToken).sid).toBe(sessionId);
      expect(await sessionIdOf(next.refreshToken)).toBe(sessionId);
    });

    it('3. SMS-code sign-in and registration issue sid = their new session', async () => {
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
      expect(claims(viaOtp.accessToken).sid).toBe(await sessionIdOf(viaOtp.refreshToken));

      const registered = await auth.register({ phone: nextPhone(), password: PASSWORD, fullName: 'New' });
      expect(claims(registered.accessToken).sid).toBe(await sessionIdOf(registered.refreshToken));
    });

    it('the access-token lifetime is still JWT_ACCESS_EXPIRES_IN (unset here → the 15m default), not the session expiry', async () => {
      const { accessToken } = await signIn();
      const { exp, iat } = claims(accessToken);
      expect(exp - iat).toBe(15 * 60);
    });
  });

  describe('validation', () => {
    it('4 & 14. a token with a live sid reaches the protected route', async () => {
      const { user, accessToken } = await signIn();
      const res = await probe(accessToken);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ id: user.id });
    });

    it('5. REGRESSION (15E.4d.2): a correctly signed token for an active user with a live session but NO sid → exactly the generic 401', async () => {
      const { user } = await signIn(); // the user has a live session; the token just does not name it
      const noSid = await sign({ sub: user.id, phone: user.phone, role: user.role, sv: 0 });
      expect(claims(noSid).sid).toBeUndefined();

      const res = await probe(noSid);

      expect(res.status).toBe(401);
      expect(res.body).toStrictEqual({ message: 'Unauthorized', statusCode: 401 });
      await expectRefused(noSid);
    });

    it('5b. sid explicitly undefined (dropped from the JSON) → generic 401', async () => {
      const { user } = await signIn();
      await expectRefused(await sign({ sub: user.id, phone: user.phone, role: user.role, sv: 0, sid: undefined }));
    });

    it('6. a sid naming no session → 401', async () => {
      const user = await createUser(prisma, nextPhone());
      await expectRefused(await sign({ sub: user.id, phone: user.phone, role: user.role, sv: 0, sid: 987654 }));
    });

    it("7. a sid naming another user's live session → 401", async () => {
      const victim = await signIn();
      const attacker = await createUser(prisma, nextPhone());
      const victimSid = await sessionIdOf(victim.refreshToken);
      await expectRefused(await sign({ sub: attacker.id, phone: attacker.phone, role: attacker.role, sv: 0, sid: victimSid }));
      expect((await probe(victim.accessToken)).status).toBe(200); // the victim is unaffected
    });

    it('malformed sid values (null, 0, -1, 1.5, "1", unsafe integer) → generic 401', async () => {
      const { user } = await signIn();
      for (const sid of [null, 0, -1, 1.5, '1', Number.MAX_SAFE_INTEGER + 2]) {
        await expectRefused(await sign({ sub: user.id, phone: user.phone, role: user.role, sv: 0, sid }));
      }
    });

    it('8. revoked session → 401 immediately: logout; another session of the same user keeps working', async () => {
      const a = await signIn();
      const b = await auth.login({ phone: a.user.phone, password: PASSWORD });
      expect((await probe(a.accessToken)).status).toBe(200);

      await auth.logout(a.refreshToken);

      await expectRefused(a.accessToken);
      expect((await probe(b.accessToken)).status).toBe(200);
      expect((await prisma.user.findUniqueOrThrow({ where: { id: a.user.id } })).sessionVersion).toBe(0);
    });

    it('8b. refresh-token reuse (15E.4c) revokes the session → its access token is refused at once', async () => {
      const { refreshToken } = await signIn();
      const next = await auth.refresh({ refreshToken });
      const presented = await prisma.refreshToken.findUniqueOrThrow({ where: { tokenHash: sha256(refreshToken) } });
      await prisma.refreshToken.update({ where: { id: presented.id }, data: { rotatedAt: new Date(Date.now() - 60_000) } });
      await auth.refresh({ refreshToken }).catch(() => undefined); // reuse → REUSE_DETECTED

      const session = await prisma.authSession.findUniqueOrThrow({ where: { id: await sessionIdOf(next.refreshToken) } });
      expect(session.revokedReason).toBe(SessionRevokedReason.REUSE_DETECTED);
      await expectRefused(next.accessToken);
    });

    it('8c. an access token minted by a refresh is refused once that session is revoked afterwards', async () => {
      const { refreshToken } = await signIn();
      const next = await auth.refresh({ refreshToken });
      expect((await probe(next.accessToken)).status).toBe(200);

      await auth.logout(next.refreshToken);

      await expectRefused(next.accessToken);
    });

    it('9. session past its absolute expiry → 401 (the JWT itself has not expired)', async () => {
      const { refreshToken, accessToken } = await signIn();
      await prisma.authSession.update({
        where: { id: await sessionIdOf(refreshToken) },
        data: { absoluteExpiresAt: new Date(Date.now() - 1000) },
      });
      expect(claims(accessToken).exp * 1000).toBeGreaterThan(Date.now());
      await expectRefused(accessToken);
    });

    it('10. suspended and deleted users → 401', async () => {
      const suspended = await signIn();
      await prisma.user.update({ where: { id: suspended.user.id }, data: { status: UserStatus.SUSPENDED } });
      await expectRefused(suspended.accessToken);

      const deleted = await signIn();
      await prisma.user.update({ where: { id: deleted.user.id }, data: { deletedAt: new Date() } });
      await expectRefused(deleted.accessToken);
    });

    it('11. sessionVersion still rules user-wide: password reset and suspension refuse every token', async () => {
      const a = await signIn();
      const b = await auth.login({ phone: a.user.phone, password: PASSWORD });
      await prisma.otpCode.create({
        data: {
          phone: a.user.phone,
          purpose: OtpPurpose.PASSWORD_RESET,
          codeHash: await bcrypt.hash('135790', 4),
          expiresAt: new Date(Date.now() + 10 * 60_000),
        },
      });

      await auth.resetPassword({ phone: a.user.phone, code: '135790', newPassword: 'brand-new-password' });

      for (const token of [a.accessToken, b.accessToken]) await expectRefused(token);

      const staffUser = await createUser(prisma, nextPhone(), UserRole.SUPER_ADMIN);
      const c = await signIn();
      await admin.suspendUser(c.user.id, { id: staffUser.id, phone: staffUser.phone, role: UserRole.SUPER_ADMIN }, 'Fraud');
      await expectRefused(c.accessToken);
    });

    it('11b. a sessionVersion mismatch alone (session live) → 401', async () => {
      const { user, accessToken } = await signIn();
      await prisma.user.update({ where: { id: user.id }, data: { sessionVersion: { increment: 1 } } });
      await expectRefused(accessToken);
    });

    it('12. an expired JWT → 401, even with a live session', async () => {
      const { user, refreshToken } = await signIn();
      const sid = await sessionIdOf(refreshToken);
      const expired = await sign({
        sub: user.id,
        phone: user.phone,
        role: user.role,
        sv: 0,
        sid,
        exp: Math.floor(Date.now() / 1000) - 60,
      });
      await expectRefused(expired);
    });

    it('13. a token signed with another secret → 401, even with a live session', async () => {
      const { user, refreshToken } = await signIn();
      const sid = await sessionIdOf(refreshToken);
      await expectRefused(await sign({ sub: user.id, phone: user.phone, role: user.role, sv: 0, sid }, 'not-the-secret'));
    });

    it('15. every refusal is the same body and discloses nothing; no token at all is the same 401', async () => {
      const res = await probe();
      expect(res.status).toBe(401);
      expect(res.body).toEqual(GENERIC_401);
    });
  });
});
