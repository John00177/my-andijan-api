import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { JwtService } from '@nestjs/jwt';
import { UserRole, UserStatus } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import { createHash } from 'crypto';
import { AuthService } from './auth.service';
import { PrismaService } from '../prisma/prisma.service';
import { SmsService } from '../sms/sms.service';
import { UploadService } from '../upload/upload.service';

jest.mock('bcrypt');

describe('AuthService.login', () => {
  let service: AuthService;
  const signAsync = jest.fn().mockResolvedValue('signed-jwt');
  let prisma: {
    user: { findUnique: jest.Mock; update: jest.Mock };
    authSession: { create: jest.Mock };
  };

  const baseUser = {
    id: 1,
    phone: '+998901234567',
    email: null,
    passwordHash: 'hashed-password',
    fullName: 'Test User',
    role: UserRole.CUSTOMER,
    status: UserStatus.ACTIVE,
    deletedAt: null,
    lastLoginAt: null,
  };

  beforeEach(async () => {
    prisma = {
      user: { findUnique: jest.fn(), update: jest.fn() },
      authSession: { create: jest.fn().mockResolvedValue({ id: 1 }) },
    };

    const moduleRef = await Test.createTestingModule({
      providers: [
        AuthService,
        { provide: PrismaService, useValue: prisma },
        { provide: JwtService, useValue: { signAsync } },
        { provide: SmsService, useValue: {} },
        { provide: UploadService, useValue: {} },
      ],
    }).compile();

    service = moduleRef.get(AuthService);
    (bcrypt.compare as jest.Mock).mockReset();
  });

  it('throws UnauthorizedException when the phone is not registered', async () => {
    prisma.user.findUnique.mockResolvedValue(null);

    await expect(service.login({ phone: '+998901234567', password: 'whatever' })).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it('throws UnauthorizedException for a soft-deleted account', async () => {
    prisma.user.findUnique.mockResolvedValue({ ...baseUser, deletedAt: new Date() });

    await expect(service.login({ phone: baseUser.phone, password: 'whatever' })).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it('throws ForbiddenException when the account is not ACTIVE', async () => {
    prisma.user.findUnique.mockResolvedValue({ ...baseUser, status: UserStatus.SUSPENDED });

    await expect(service.login({ phone: baseUser.phone, password: 'whatever' })).rejects.toThrow(
      ForbiddenException,
    );
  });

  it('throws UnauthorizedException on a wrong password', async () => {
    prisma.user.findUnique.mockResolvedValue(baseUser);
    (bcrypt.compare as jest.Mock).mockResolvedValue(false);

    await expect(service.login({ phone: baseUser.phone, password: 'wrong' })).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it('returns tokens and a sanitized user on success', async () => {
    prisma.user.findUnique.mockResolvedValue(baseUser);
    prisma.user.update.mockResolvedValue({ ...baseUser, lastLoginAt: new Date() });
    (bcrypt.compare as jest.Mock).mockResolvedValue(true);

    const result = await service.login({ phone: baseUser.phone, password: 'correct' });

    expect(result.user).not.toHaveProperty('passwordHash');
    expect(result.accessToken).toBe('signed-jwt');
    expect(/^[0-9a-f]{96}$/.test(result.refreshToken)).toBe(true);
    expect(prisma.user.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: baseUser.id } }),
    );
  });

  it('one sign-in = exactly one AuthSession (90-day absolute expiry) holding its first token, stored as SHA-256 only', async () => {
    prisma.user.findUnique.mockResolvedValue(baseUser);
    prisma.user.update.mockResolvedValue({ ...baseUser, lastLoginAt: new Date() });
    (bcrypt.compare as jest.Mock).mockResolvedValue(true);

    const before = Date.now();
    const result = await service.login({ phone: baseUser.phone, password: 'correct' });

    expect(prisma.authSession.create).toHaveBeenCalledTimes(1);
    // The access token is bound to the session just created (Phase 15E.4d.1).
    expect(signAsync).toHaveBeenLastCalledWith(
      expect.objectContaining({ sub: baseUser.id, sid: 1 }),
      expect.objectContaining({ secret: process.env.JWT_ACCESS_SECRET }),
    );
    const { data } = prisma.authSession.create.mock.calls[0][0];
    expect(data.userId).toBe(baseUser.id);
    const lifetime = data.absoluteExpiresAt.getTime() - data.createdAt.getTime();
    expect(lifetime).toBe(90 * 24 * 60 * 60 * 1000);
    expect(data.createdAt.getTime()).toBeGreaterThanOrEqual(before);

    const token = data.refreshTokens.create;
    expect(token.userId).toBe(baseUser.id);
    expect(token.tokenHash).toBe(createHash('sha256').update(result.refreshToken).digest('hex'));
    expect(token.expiresAt.getTime()).toBeLessThanOrEqual(data.absoluteExpiresAt.getTime());
    // The raw token is never written anywhere.
    expect(JSON.stringify(prisma.authSession.create.mock.calls).includes(result.refreshToken)).toBe(false);
    expect(prisma.user.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: baseUser.id } }),
    );
  });
});
