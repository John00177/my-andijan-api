import { UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { OtpPurpose, UserRole, UserStatus } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import { AuthService } from './auth.service';
import { JwtPayload, JwtStrategy } from './strategies/jwt.strategy';
import { AdminService } from '../admin/admin.service';
import { PrismaService } from '../prisma/prisma.service';
import { SmsService } from '../sms/sms.service';
import { UploadService } from '../upload/upload.service';
import { ReviewsService } from '../reviews/reviews.service';

// Phase 15B end-to-end session revocation, against ONE in-memory database
// shared by the real AuthService, AdminService and JwtStrategy:
//   active session → suspension / password reset → the old access token and
//   the old refresh token are both dead → a fresh login works again.
process.env.JWT_ACCESS_SECRET = 'test-access-secret';

type UserRow = {
  id: number;
  phone: string;
  passwordHash: string;
  fullName: string;
  role: UserRole;
  status: UserStatus;
  sessionVersion: number;
  deletedAt: Date | null;
  lastLoginAt: Date | null;
};
type TokenRow = { id: number; userId: number; tokenHash: string; expiresAt: Date; revokedAt: Date | null };
type OtpRow = {
  id: number;
  phone: string;
  codeHash: string;
  purpose: OtpPurpose;
  attempts: number;
  expiresAt: Date;
  usedAt: Date | null;
};

function applyData<T extends Record<string, unknown>>(row: T, data: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(data)) {
    if (value && typeof value === 'object' && 'increment' in (value as object)) {
      (row as Record<string, unknown>)[key] = (row[key] as number) + (value as { increment: number }).increment;
    } else if (value !== undefined) {
      (row as Record<string, unknown>)[key] = value;
    }
  }
}

function matches(row: Record<string, unknown>, where: Record<string, unknown>): boolean {
  return Object.entries(where).every(([key, value]) => row[key] === value);
}

function createDb() {
  const users: UserRow[] = [];
  const tokens: TokenRow[] = [];
  const otps: OtpRow[] = [];
  const audit: unknown[] = [];

  const db = {
    users,
    tokens,
    otps,
    audit,
    user: {
      findUnique: async ({ where }: { where: Partial<UserRow> }) => users.find((u) => matches(u, where)) ?? null,
      findFirst: async ({ where }: { where: Partial<UserRow> }) => users.find((u) => matches(u, where)) ?? null,
      findUniqueOrThrow: async ({ where }: { where: Partial<UserRow> }) => {
        const found = users.find((u) => matches(u, where));
        if (!found) throw new Error('not found');
        return found;
      },
      update: async ({ where, data }: { where: Partial<UserRow>; data: Record<string, unknown> }) => {
        const found = users.find((u) => matches(u, where));
        if (!found) throw new Error('not found');
        applyData(found, data);
        return found;
      },
      updateMany: async ({ where, data }: { where: Partial<UserRow>; data: Record<string, unknown> }) => {
        const hit = users.filter((u) => matches(u, where));
        hit.forEach((u) => applyData(u, data));
        return { count: hit.length };
      },
    },
    refreshToken: {
      create: async ({ data }: { data: Omit<TokenRow, 'id' | 'revokedAt'> }) => {
        const row = { id: tokens.length + 1, revokedAt: null, ...data };
        tokens.push(row);
        return row;
      },
      findUnique: async ({ where }: { where: { tokenHash: string } }) => {
        const row = tokens.find((t) => t.tokenHash === where.tokenHash);
        return row ? { ...row, user: users.find((u) => u.id === row.userId) } : null;
      },
      update: async ({ where, data }: { where: { id: number }; data: Record<string, unknown> }) => {
        const row = tokens.find((t) => t.id === where.id)!;
        applyData(row, data);
        return row;
      },
      updateMany: async ({ where, data }: { where: Partial<TokenRow>; data: Record<string, unknown> }) => {
        const hit = tokens.filter((t) => matches(t, where));
        hit.forEach((t) => applyData(t, data));
        return { count: hit.length };
      },
    },
    otpCode: {
      findMany: async ({ where }: { where: { phone: string; purpose: OtpPurpose } }) =>
        otps.filter((o) => o.phone === where.phone && o.purpose === where.purpose && !o.usedAt && o.expiresAt > new Date()),
      update: async ({ where, data }: { where: { id: number }; data: Record<string, unknown> }) => {
        const row = otps.find((o) => o.id === where.id)!;
        applyData(row, data);
        return row;
      },
    },
    auditLog: { create: async ({ data }: { data: unknown }) => audit.push(data) },
    $transaction: async (arg: unknown) =>
      typeof arg === 'function' ? (arg as (tx: unknown) => unknown)(db) : Promise.all(arg as Promise<unknown>[]),
  };
  return db;
}

describe('Session security (Phase 15B)', () => {
  let db: ReturnType<typeof createDb>;
  let auth: AuthService;
  let admin: AdminService;
  let strategy: JwtStrategy;
  const jwt = new JwtService({});

  const PHONE = '+998901112233';
  const superAdmin = { id: 1, phone: '+998900000001', role: UserRole.SUPER_ADMIN };

  async function authenticate(accessToken: string) {
    const payload = jwt.verify<JwtPayload>(accessToken, { secret: process.env.JWT_ACCESS_SECRET });
    return strategy.validate(payload);
  }

  beforeEach(async () => {
    db = createDb();
    db.users.push({
      id: 2,
      phone: PHONE,
      passwordHash: await bcrypt.hash('old-password', 4),
      fullName: 'Owner',
      role: UserRole.BUSINESS_OWNER,
      status: UserStatus.ACTIVE,
      sessionVersion: 0,
      deletedAt: null,
      lastLoginAt: null,
    });
    const prisma = db as unknown as PrismaService;
    auth = new AuthService(prisma, jwt, {} as SmsService, {} as UploadService);
    admin = new AdminService(prisma, {} as ReviewsService);
    strategy = new JwtStrategy(prisma);
  });

  it('a token issued before Phase 15B (no `sv` claim) stays valid while the account is untouched', async () => {
    const legacy = await jwt.signAsync(
      { sub: 2, phone: PHONE, role: UserRole.BUSINESS_OWNER },
      { secret: process.env.JWT_ACCESS_SECRET },
    );
    await expect(authenticate(legacy)).resolves.toEqual(expect.objectContaining({ id: 2 }));
  });

  it('active session → suspension → the old access AND refresh tokens are refused', async () => {
    const session = await auth.login({ phone: PHONE, password: 'old-password' });
    await expect(authenticate(session.accessToken)).resolves.toEqual(expect.objectContaining({ id: 2 }));

    await admin.suspendUser(2, superAdmin, 'Fraud report');

    await expect(authenticate(session.accessToken)).rejects.toThrow(UnauthorizedException);
    await expect(auth.refresh({ refreshToken: session.refreshToken })).rejects.toThrow(UnauthorizedException);
    expect(db.tokens.every((t) => t.revokedAt)).toBe(true);
  });

  it('reinstating the account does NOT revive the pre-suspension session; a fresh login does work', async () => {
    const session = await auth.login({ phone: PHONE, password: 'old-password' });
    await admin.suspendUser(2, superAdmin, 'Fraud report');
    await admin.activateUser(2, superAdmin, 'Cleared');

    await expect(authenticate(session.accessToken)).rejects.toThrow('Session has been revoked');
    await expect(auth.refresh({ refreshToken: session.refreshToken })).rejects.toThrow(UnauthorizedException);

    const fresh = await auth.login({ phone: PHONE, password: 'old-password' });
    await expect(authenticate(fresh.accessToken)).resolves.toEqual(expect.objectContaining({ id: 2 }));
  });

  it('password reset kills every existing session; only the new password signs in, and that session works', async () => {
    const session = await auth.login({ phone: PHONE, password: 'old-password' });
    db.otps.push({
      id: 1,
      phone: PHONE,
      codeHash: await bcrypt.hash('123456', 4),
      purpose: OtpPurpose.PASSWORD_RESET,
      attempts: 0,
      expiresAt: new Date(Date.now() + 10 * 60_000),
      usedAt: null,
    });

    await auth.resetPassword({ phone: PHONE, code: '123456', newPassword: 'new-password-1' });

    await expect(authenticate(session.accessToken)).rejects.toThrow(UnauthorizedException);
    await expect(auth.refresh({ refreshToken: session.refreshToken })).rejects.toThrow(UnauthorizedException);
    await expect(auth.login({ phone: PHONE, password: 'old-password' })).rejects.toThrow(UnauthorizedException);

    const fresh = await auth.login({ phone: PHONE, password: 'new-password-1' });
    await expect(authenticate(fresh.accessToken)).resolves.toEqual(expect.objectContaining({ id: 2 }));
    await expect(auth.refresh({ refreshToken: fresh.refreshToken })).resolves.toEqual(
      expect.objectContaining({ accessToken: expect.any(String) }),
    );
    expect(db.audit).toContainEqual(
      expect.objectContaining({ entityType: 'UserCredentials', entityId: 2, after: { passwordReset: true, sessionsRevoked: 1 } }),
    );
  });

  it("a password reset doesn't touch other users' sessions", async () => {
    db.users.push({ ...db.users[0], id: 3, phone: '+998901112244' });
    const other = await auth.login({ phone: '+998901112244', password: 'old-password' });
    db.otps.push({
      id: 1,
      phone: PHONE,
      codeHash: await bcrypt.hash('123456', 4),
      purpose: OtpPurpose.PASSWORD_RESET,
      attempts: 0,
      expiresAt: new Date(Date.now() + 10 * 60_000),
      usedAt: null,
    });

    await auth.resetPassword({ phone: PHONE, code: '123456', newPassword: 'new-password-1' });

    await expect(authenticate(other.accessToken)).resolves.toEqual(expect.objectContaining({ id: 3 }));
    await expect(auth.refresh({ refreshToken: other.refreshToken })).resolves.toBeDefined();
  });
});
