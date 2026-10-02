import { BadRequestException, ForbiddenException, Logger, ServiceUnavailableException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { OtpPurpose, UserRole, UserStatus } from '@prisma/client';
import { readFileSync } from 'fs';
import { join } from 'path';
import { AuthService } from './auth.service';
import { PrismaService } from '../prisma/prisma.service';
import { SmsService } from '../sms/sms.service';
import { UploadService } from '../upload/upload.service';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const nodeCrypto: typeof import('crypto') = require('crypto');

// Phase 15E.2 — authentication-code security. The real AuthService runs
// against an in-memory store that reproduces the Postgres semantics the code
// relies on (conditional updates are atomic; every call yields, so concurrent
// requests really interleave). bcrypt is replaced by a transparent stand-in
// so the tests can count hashing work and read back which value was hashed.
const mockBcrypt = { hashed: [] as string[], hashCalls: 0, compareCalls: 0 };
jest.mock('bcrypt', () => ({
  hash: jest.fn(async (value: string) => {
    mockBcrypt.hashCalls++;
    mockBcrypt.hashed.push(value);
    return `h:${value}`;
  }),
  compare: jest.fn(async (value: string, hash: string) => {
    mockBcrypt.compareCalls++;
    return hash === `h:${value}`;
  }),
}));

process.env.JWT_ACCESS_SECRET = 'test-access-secret';

type Otp = {
  id: number;
  phone: string;
  codeHash: string;
  purpose: OtpPurpose;
  attempts: number;
  expiresAt: Date;
  usedAt: Date | null;
  createdAt: Date;
};
type User = {
  id: number;
  phone: string;
  passwordHash: string;
  fullName: string;
  role: UserRole;
  status: UserStatus;
  sessionVersion: number;
  deletedAt: Date | null;
};
type Session = { id: number; userId: number; revokedAt: Date | null; revokedReason: string | null };
type Where = Record<string, any>;

const tick = () => new Promise((resolve) => setImmediate(resolve));

function apply(row: Record<string, any>, data: Record<string, any>): void {
  for (const [key, value] of Object.entries(data)) {
    if (value && typeof value === 'object' && 'increment' in value) row[key] += value.increment;
    else if (value && typeof value === 'object' && 'decrement' in value) row[key] -= value.decrement;
    else row[key] = value;
  }
}

function otpMatches(o: Otp, w: Where): boolean {
  return (
    (w.id === undefined || (typeof w.id === 'object' ? o.id !== w.id.not : o.id === w.id)) &&
    (w.phone === undefined || o.phone === w.phone) &&
    (w.purpose === undefined || o.purpose === w.purpose) &&
    (w.usedAt === undefined || o.usedAt === w.usedAt) &&
    (!w.expiresAt || o.expiresAt > w.expiresAt.gt) &&
    (!w.attempts || o.attempts < w.attempts.lt) &&
    (!w.createdAt || o.createdAt >= w.createdAt.gte)
  );
}

function createDb() {
  const users: User[] = [];
  const otps: Otp[] = [];
  const tokens: Array<{ id: number; userId: number; sessionId: number | null; revokedAt: Date | null }> = [];
  const sessions: Session[] = [];
  const audit: Array<Record<string, any>> = [];
  const findUser = (w: Where) => users.find((u) => (w.id !== undefined ? u.id === w.id : u.phone === w.phone));

  const db = {
    users,
    otps,
    tokens,
    sessions,
    audit,
    user: {
      findUnique: async ({ where }: { where: Where }) => (await tick(), findUser(where) ?? null),
      create: async ({ data }: { data: Partial<User> }) => {
        const user = { id: 500 + users.length, sessionVersion: 0, status: UserStatus.ACTIVE, deletedAt: null, ...data } as User;
        users.push(user);
        return user;
      },
      update: async ({ where, data }: { where: Where; data: Record<string, any> }) => {
        await tick();
        const user = findUser(where)!;
        apply(user, data);
        return user;
      },
    },
    otpCode: {
      findFirst: async ({ where }: { where: Where }) =>
        (await tick(), otps.filter((o) => otpMatches(o, where)).sort((a, b) => b.id - a.id)[0] ?? null),
      aggregate: async ({ where }: { where: Where }) => {
        await tick();
        return { _sum: { attempts: otps.filter((o) => otpMatches(o, where)).reduce((sum, o) => sum + o.attempts, 0) } };
      },
      count: async ({ where }: { where: Where }) => otps.filter((o) => otpMatches(o, where)).length,
      create: async ({ data }: { data: Partial<Otp> }) => {
        await tick();
        const row = { id: otps.length + 1, attempts: 0, usedAt: null, createdAt: new Date(), ...data } as Otp;
        otps.push(row);
        return row;
      },
      update: async ({ where, data }: { where: Where; data: Record<string, any> }) => {
        await tick();
        const row = otps.find((o) => o.id === where.id)!;
        apply(row, data);
        return row;
      },
      // Filter + write with no yield in between: atomic, like one UPDATE.
      updateMany: async ({ where, data }: { where: Where; data: Record<string, any> }) => {
        await tick();
        const hit = otps.filter((o) => otpMatches(o, where));
        hit.forEach((o) => apply(o, data));
        return { count: hit.length };
      },
    },
    // Sign-in writes one AuthSession with its first token nested (15E.4b);
    // user-wide revocation updates both tables by userId.
    authSession: {
      create: async ({ data }: { data: Record<string, any> }) => {
        const { refreshTokens, ...session } = data;
        const row = { id: sessions.length + 1, revokedAt: null, revokedReason: null, ...session } as Session;
        sessions.push(row);
        if (refreshTokens?.create) {
          tokens.push({ id: tokens.length + 1, sessionId: row.id, revokedAt: null, ...refreshTokens.create });
        }
        return { id: row.id };
      },
      updateMany: async ({ where, data }: { where: Where; data: Record<string, any> }) => {
        const hit = sessions.filter((s) => s.userId === where.userId && s.revokedAt === null);
        hit.forEach((s) => apply(s, data));
        return { count: hit.length };
      },
    },
    refreshToken: {
      updateMany: async ({ where, data }: { where: Where; data: Record<string, any> }) => {
        const hit = tokens.filter(
          (t) =>
            t.userId === where.userId &&
            t.revokedAt === null &&
            (where.sessionId === undefined || t.sessionId === where.sessionId),
        );
        hit.forEach((t) => apply(t, data));
        return { count: hit.length };
      },
    },
    auditLog: { create: async ({ data }: { data: Record<string, any> }) => (audit.push(data), data) },
    $transaction: async (arg: unknown) =>
      typeof arg === 'function' ? (arg as (tx: unknown) => unknown)(db) : Promise.all(arg as Promise<unknown>[]),
  };
  return db;
}

const PHONE = '+998901112233';
const STAFF = [UserRole.SUPPORT, UserRole.MODERATOR, UserRole.ADMIN, UserRole.SUPER_ADMIN];
const SIX_DIGITS = /\b\d{6}\b/;

describe('Authentication codes (Phase 15E.2)', () => {
  let db: ReturnType<typeof createDb>;
  let sms: { isConfigured: boolean; send: jest.Mock };
  let auth: AuthService;
  let logged: jest.SpyInstance[];

  const addUser = (role: UserRole = UserRole.CUSTOMER, phone = PHONE) => {
    const user: User = {
      id: db.users.length + 1,
      phone,
      passwordHash: 'h:old-password',
      fullName: 'Test',
      role,
      status: UserStatus.ACTIVE,
      sessionVersion: 0,
      deletedAt: null,
    };
    db.users.push(user);
    return user;
  };
  /** The code inside the n-th SMS sent (never printed — only compared). */
  const codeFromSms = (n = sms.send.mock.calls.length - 1): string => String(sms.send.mock.calls[n][1]).match(SIX_DIGITS)![0];
  const settle = async () => {
    for (let i = 0; i < 10; i++) await tick();
  };
  const everythingLogged = () => logged.flatMap((spy) => spy.mock.calls.flat()).map(String).join('\n');

  beforeEach(() => {
    mockBcrypt.hashed = [];
    mockBcrypt.hashCalls = 0;
    mockBcrypt.compareCalls = 0;
    db = createDb();
    sms = { isConfigured: true, send: jest.fn().mockResolvedValue(true) };
    auth = new AuthService(db as unknown as PrismaService, new JwtService({}), sms as unknown as SmsService, {} as UploadService);
    logged = [
      ...(['log', 'warn', 'error', 'debug', 'verbose'] as const).map((m) =>
        jest.spyOn(Logger.prototype, m).mockImplementation(() => undefined),
      ),
      ...(['log', 'info', 'warn', 'error', 'debug'] as const).map((m) => jest.spyOn(console, m).mockImplementation(() => undefined)),
    ];
  });

  afterEach(() => jest.restoreAllMocks());

  describe('code generation', () => {
    it('password-reset codes come from crypto.randomInt — Math.random is never called', async () => {
      addUser();
      const random = jest.spyOn(Math, 'random');
      const randomInt = jest.spyOn(nodeCrypto, 'randomInt');
      await auth.forgotPassword({ phone: PHONE });
      expect(randomInt).toHaveBeenCalledWith(100000, 1000000);
      expect(random).not.toHaveBeenCalled();
      expect(codeFromSms()).toMatch(/^\d{6}$/);
    });

    it('no Math.random in the auth or SMS source (comments excluded)', () => {
      for (const file of ['auth.service.ts', '../sms/sms.service.ts']) {
        const code = readFileSync(join(__dirname, file), 'utf8')
          .replace(/\/\*[\s\S]*?\*\//g, '')
          .replace(/\/\/.*$/gm, '');
        expect({ file, usesMathRandom: code.includes('Math.random') }).toEqual({ file, usesMathRandom: false });
      }
    });
  });

  describe('codes are never logged, returned or thrown', () => {
    it('OTP sign-in request: the code goes only into the SMS', async () => {
      const result = await auth.requestOtp({ phone: PHONE });
      const code = codeFromSms();
      expect(JSON.stringify(result)).not.toContain(code);
      expect(everythingLogged()).not.toContain(code);
    });

    it('password reset with a failed SMS: the failure is logged, the code and phone are not', async () => {
      addUser();
      sms.send.mockResolvedValue(false);
      const result = await auth.forgotPassword({ phone: PHONE });
      await settle();
      const code = codeFromSms();
      expect(JSON.stringify(result)).not.toContain(code);
      expect(everythingLogged()).toContain('not delivered');
      expect(everythingLogged()).not.toContain(code);
      expect(everythingLogged()).not.toContain(PHONE);
    });

    it('OTP sign-in with a failed SMS: 503, and the code is in neither the exception nor the logs', async () => {
      sms.send.mockResolvedValue(false);
      const error = await auth.requestOtp({ phone: PHONE }).catch((e) => e);
      expect(error).toBeInstanceOf(ServiceUnavailableException);
      const code = codeFromSms();
      expect(JSON.stringify(error.getResponse())).not.toContain(code);
      expect(everythingLogged()).not.toContain(code);
    });

    it('with SMS unconfigured nothing is generated, stored, sent or logged — the request fails closed (503)', async () => {
      addUser();
      sms.isConfigured = false;
      await expect(auth.requestOtp({ phone: PHONE })).rejects.toBeInstanceOf(ServiceUnavailableException);
      await expect(auth.forgotPassword({ phone: PHONE })).rejects.toBeInstanceOf(ServiceUnavailableException);
      expect(mockBcrypt.hashed).toEqual([]);
      expect(db.otps).toEqual([]);
      expect(sms.send).not.toHaveBeenCalled();
      expect(everythingLogged()).not.toMatch(SIX_DIGITS);
    });

    it('SmsService itself never logs the message or the phone (unconfigured, provider error, network error)', async () => {
      const message = 'My Andijan tasdiqlash kodi: 482915. @myandijan.uz #482915';
      const saved = { email: process.env.ESKIZ_EMAIL, password: process.env.ESKIZ_PASSWORD };
      const fetchSpy = jest.spyOn(global, 'fetch');
      try {
        delete process.env.ESKIZ_EMAIL;
        delete process.env.ESKIZ_PASSWORD;
        expect(await new SmsService().send(PHONE, message)).toBe(false);

        process.env.ESKIZ_EMAIL = 'test-account@example.invalid';
        process.env.ESKIZ_PASSWORD = 'test-only-value';
        fetchSpy
          .mockResolvedValueOnce(new Response(JSON.stringify({ data: { token: 't' } }), { status: 200 }))
          .mockResolvedValueOnce(new Response(`rejected: ${message}`, { status: 500 }));
        const service = new SmsService();
        expect(await service.send(PHONE, message)).toBe(false);
        fetchSpy.mockRejectedValueOnce(new Error(`socket closed while sending ${message}`));
        expect(await service.send(PHONE, message)).toBe(false);
        fetchSpy.mockResolvedValueOnce(new Response('{}', { status: 200 }));
        expect(await service.send(PHONE, message)).toBe(true);
      } finally {
        process.env.ESKIZ_EMAIL = saved.email;
        process.env.ESKIZ_PASSWORD = saved.password;
        if (saved.email === undefined) delete process.env.ESKIZ_EMAIL;
        if (saved.password === undefined) delete process.env.ESKIZ_PASSWORD;
      }
      expect(everythingLogged()).not.toContain('482915');
      expect(everythingLogged()).not.toContain(PHONE);
      expect(everythingLogged()).not.toContain(PHONE.replace('+', ''));
    });
  });

  describe('one live code per phone and purpose', () => {
    it('a new reset code retires the previous one, in the same transaction', async () => {
      addUser();
      await auth.forgotPassword({ phone: PHONE });
      const first = codeFromSms();
      await auth.forgotPassword({ phone: PHONE });
      const second = codeFromSms();
      expect(db.otps[0].usedAt).not.toBeNull();
      expect(db.otps.filter((o) => o.usedAt === null)).toHaveLength(1);
      if (first !== second) await expect(auth.verifyResetCode({ phone: PHONE, code: first })).rejects.toThrow(BadRequestException);
      await expect(auth.verifyResetCode({ phone: PHONE, code: second })).resolves.toEqual({ valid: true });
    });

    it('an expired code is refused', async () => {
      addUser();
      await auth.forgotPassword({ phone: PHONE });
      db.otps[0].expiresAt = new Date(Date.now() - 1000);
      await expect(auth.verifyResetCode({ phone: PHONE, code: codeFromSms() })).rejects.toThrow(BadRequestException);
    });

    it('a used code is refused', async () => {
      addUser();
      await auth.forgotPassword({ phone: PHONE });
      const code = codeFromSms();
      await auth.resetPassword({ phone: PHONE, code, newPassword: 'new-password-1' });
      await expect(auth.resetPassword({ phone: PHONE, code, newPassword: 'new-password-2' })).rejects.toThrow(BadRequestException);
    });
  });

  describe('wrong-guess budget per phone and purpose, across every code row', () => {
    const wrong = (code: string) => (code === '000000' ? '000001' : '000000');

    it('3 wrong on one code + 2 wrong on its replacement exhaust the budget: the right code is then refused', async () => {
      addUser();
      await auth.forgotPassword({ phone: PHONE });
      for (let i = 0; i < 3; i++) await auth.verifyResetCode({ phone: PHONE, code: wrong(codeFromSms()) }).catch(() => undefined);
      await auth.forgotPassword({ phone: PHONE });
      const current = codeFromSms();
      for (let i = 0; i < 2; i++) await auth.verifyResetCode({ phone: PHONE, code: wrong(current) }).catch(() => undefined);
      await expect(auth.verifyResetCode({ phone: PHONE, code: current })).rejects.toThrow(BadRequestException);
      await expect(auth.resetPassword({ phone: PHONE, code: current, newPassword: 'x-password-1' })).rejects.toThrow(
        BadRequestException,
      );
    });

    it('requesting a fresh code after 5 failures does not buy more guesses', async () => {
      addUser();
      await auth.forgotPassword({ phone: PHONE });
      for (let i = 0; i < 5; i++) await auth.verifyResetCode({ phone: PHONE, code: wrong(codeFromSms()) }).catch(() => undefined);
      await auth.forgotPassword({ phone: PHONE });
      await expect(auth.verifyResetCode({ phone: PHONE, code: codeFromSms() })).rejects.toThrow(BadRequestException);
    });

    it('the same budget protects OTP sign-in', async () => {
      await auth.requestOtp({ phone: PHONE });
      for (let i = 0; i < 5; i++) await auth.verifyOtp({ phone: PHONE, otp: wrong(codeFromSms()) }).catch(() => undefined);
      await expect(auth.verifyOtp({ phone: PHONE, otp: codeFromSms() })).rejects.toThrow(BadRequestException);
    });

    it('correct guesses do not spend the budget', async () => {
      addUser();
      await auth.forgotPassword({ phone: PHONE });
      for (let i = 0; i < 7; i++) await auth.verifyResetCode({ phone: PHONE, code: codeFromSms() });
      expect(db.otps[0].attempts).toBe(0);
    });

    it('failures older than the window stop counting', async () => {
      addUser();
      await auth.forgotPassword({ phone: PHONE });
      for (let i = 0; i < 5; i++) await auth.verifyResetCode({ phone: PHONE, code: wrong(codeFromSms()) }).catch(() => undefined);
      db.otps[0].createdAt = new Date(Date.now() - 61 * 60_000);
      await auth.forgotPassword({ phone: PHONE });
      await expect(auth.verifyResetCode({ phone: PHONE, code: codeFromSms() })).resolves.toEqual({ valid: true });
    });
  });

  describe('atomic single use', () => {
    it('two concurrent resets with the same code: exactly one succeeds', async () => {
      const user = addUser();
      await auth.forgotPassword({ phone: PHONE });
      const code = codeFromSms();
      const results = await Promise.allSettled([
        auth.resetPassword({ phone: PHONE, code, newPassword: 'winner-password-1' }),
        auth.resetPassword({ phone: PHONE, code, newPassword: 'winner-password-2' }),
      ]);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      const loser = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
      expect(loser.reason).toBeInstanceOf(BadRequestException);
      expect(user.sessionVersion).toBe(1);
      expect(db.audit).toHaveLength(1);
    });

    it('two concurrent OTP sign-ins with the same code: exactly one gets a session', async () => {
      addUser(UserRole.CUSTOMER);
      await auth.requestOtp({ phone: PHONE });
      const otp = codeFromSms();
      const results = await Promise.allSettled([auth.verifyOtp({ phone: PHONE, otp }), auth.verifyOtp({ phone: PHONE, otp })]);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect(db.sessions).toHaveLength(1);
      expect(db.tokens).toHaveLength(1);
    });
  });

  describe('OTP sign-in is for customers and business owners only', () => {
    it.each([UserRole.CUSTOMER, UserRole.BUSINESS_OWNER])('%s signs in with an SMS code', async (role) => {
      addUser(role);
      await auth.requestOtp({ phone: PHONE });
      const result = await auth.verifyOtp({ phone: PHONE, otp: codeFromSms() });
      expect(result.user.role).toBe(role);
      expect(result.accessToken).toEqual(expect.any(String));
    });

    it('a new phone number still signs up as CUSTOMER', async () => {
      await auth.requestOtp({ phone: PHONE });
      const result = await auth.verifyOtp({ phone: PHONE, otp: codeFromSms() });
      expect(result.user.role).toBe(UserRole.CUSTOMER);
    });

    it.each(STAFF)('%s is refused even with a valid code — generic message, code spent, no session', async (role) => {
      addUser(role);
      await auth.requestOtp({ phone: PHONE });
      const error = await auth.verifyOtp({ phone: PHONE, otp: codeFromSms() }).catch((e) => e);
      expect(error).toBeInstanceOf(ForbiddenException);
      const body = JSON.stringify(error.getResponse());
      for (const name of [...STAFF, 'staff', 'role']) expect(body.toLowerCase()).not.toContain(name.toLowerCase());
      expect(db.otps[0].usedAt).not.toBeNull();
      expect(db.sessions).toHaveLength(0);
      expect(db.tokens).toHaveLength(0);
    });
  });

  describe('timing equalization', () => {
    it('forgot-password does the same bcrypt work and answers the same for unknown and known phones', async () => {
      const unknown = await auth.forgotPassword({ phone: '+998909999999' });
      const unknownHashes = mockBcrypt.hashCalls;
      addUser();
      mockBcrypt.hashCalls = 0;
      const known = await auth.forgotPassword({ phone: PHONE });
      expect(unknownHashes).toBe(1);
      expect(mockBcrypt.hashCalls).toBe(1);
      expect(unknown).toEqual(known);
    });

    it('checking a code when none was issued still costs a bcrypt comparison', async () => {
      const error = await auth.verifyResetCode({ phone: '+998909999999', code: '123456' }).catch((e) => e);
      expect(error).toBeInstanceOf(BadRequestException);
      expect(mockBcrypt.compareCalls).toBe(1);
    });
  });

  describe('a password reset ends every session (Phase 15B behaviour preserved)', () => {
    it('bumps sessionVersion, revokes all refresh tokens and writes the audit row', async () => {
      const user = addUser(UserRole.BUSINESS_OWNER);
      await auth.login({ phone: PHONE, password: 'old-password' });
      await auth.login({ phone: PHONE, password: 'old-password' });
      await auth.forgotPassword({ phone: PHONE });
      await auth.resetPassword({ phone: PHONE, code: codeFromSms(), newPassword: 'new-password-1' });
      expect(user.sessionVersion).toBe(1);
      expect(user.passwordHash).toBe('h:new-password-1');
      expect(db.tokens.every((t) => t.revokedAt !== null)).toBe(true);
      expect(db.sessions.every((s) => s.revokedAt !== null && s.revokedReason === 'PASSWORD_RESET')).toBe(true);
      expect(db.audit).toContainEqual(
        expect.objectContaining({
          entityType: 'UserCredentials',
          after: { passwordReset: true, sessionsRevoked: 2, tokensRevoked: 2 },
        }),
      );
    });
  });

  describe('SMS delivery', () => {
    it('OTP and reset codes are sent through SmsService to the requesting phone', async () => {
      addUser();
      await auth.requestOtp({ phone: PHONE });
      await auth.forgotPassword({ phone: PHONE });
      await settle();
      expect(sms.send).toHaveBeenCalledTimes(2);
      for (const [phone, message] of sms.send.mock.calls) {
        expect(phone).toBe(PHONE);
        expect(message).toMatch(/@myandijan\.uz #\d{6}$/);
      }
    });

    it('an undelivered OTP sign-in code is retired', async () => {
      sms.send.mockResolvedValue(false);
      await expect(auth.requestOtp({ phone: PHONE })).rejects.toBeInstanceOf(ServiceUnavailableException);
      expect(db.otps[0].usedAt).not.toBeNull();
    });

    it('an undelivered reset code is retired; the response stays generic', async () => {
      addUser();
      sms.send.mockResolvedValue(false);
      await expect(auth.forgotPassword({ phone: PHONE })).resolves.toEqual({ message: 'Kod yuborildi' });
      await settle();
      expect(db.otps[0].usedAt).not.toBeNull();
    });
  });
});
