import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { JwtService } from '@nestjs/jwt';
import { UserRole, UserStatus } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import { AuthService } from './auth.service';
import { PrismaService } from '../prisma/prisma.service';
import { SmsService } from '../sms/sms.service';
import { UploadService } from '../upload/upload.service';

jest.mock('bcrypt');

describe('AuthService.login', () => {
  let service: AuthService;
  let prisma: {
    user: { findUnique: jest.Mock; update: jest.Mock };
    refreshToken: { create: jest.Mock };
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
      refreshToken: { create: jest.fn().mockResolvedValue({}) },
    };

    const moduleRef = await Test.createTestingModule({
      providers: [
        AuthService,
        { provide: PrismaService, useValue: prisma },
        { provide: JwtService, useValue: { signAsync: jest.fn().mockResolvedValue('signed-jwt') } },
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
    expect(typeof result.refreshToken).toBe('string');
    expect(prisma.refreshToken.create).toHaveBeenCalledTimes(1);
    expect(prisma.user.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: baseUser.id } }),
    );
  });
});
