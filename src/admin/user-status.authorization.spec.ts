import { ConflictException, ForbiddenException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AuditAction, SessionRevokedReason, UserRole, UserStatus } from '@prisma/client';
import { AdminService } from './admin.service';
import { PrismaService } from '../prisma/prisma.service';
import { ReviewsService } from '../reviews/reviews.service';
import { AuthenticatedUser } from '../auth/strategies/jwt.strategy';
import { assertCanChangeUserStatus, REACTIVATABLE_TARGETS, SUSPENDABLE_TARGETS } from '../authz/user-status.policy';

// Phase 15B (D-74): who may suspend / reinstate whom. The expected tables
// below are written out by hand — deliberately NOT derived from the policy
// module — so any change to the policy has to be made twice, on purpose.
const ROLES = [
  UserRole.CUSTOMER,
  UserRole.BUSINESS_OWNER,
  UserRole.SUPPORT,
  UserRole.MODERATOR,
  UserRole.ADMIN,
  UserRole.SUPER_ADMIN,
] as const;

const EXPECTED_SUSPEND: Record<UserRole, UserRole[]> = {
  CUSTOMER: [],
  BUSINESS_OWNER: [],
  SUPPORT: [],
  MODERATOR: [],
  ADMIN: [UserRole.CUSTOMER, UserRole.BUSINESS_OWNER],
  SUPER_ADMIN: [UserRole.CUSTOMER, UserRole.BUSINESS_OWNER, UserRole.MODERATOR, UserRole.SUPPORT, UserRole.ADMIN],
};

const EXPECTED_ACTIVATE: Record<UserRole, UserRole[]> = {
  CUSTOMER: [],
  BUSINESS_OWNER: [],
  SUPPORT: [],
  MODERATOR: [],
  ADMIN: [UserRole.CUSTOMER, UserRole.BUSINESS_OWNER],
  SUPER_ADMIN: [UserRole.CUSTOMER, UserRole.BUSINESS_OWNER, UserRole.MODERATOR, UserRole.SUPPORT],
};

const actorOf = (role: UserRole): AuthenticatedUser => ({ id: 1, phone: '+998900000001', role });
const targetOf = (role: UserRole) => ({ id: 2, role });

describe('User status policy — full actor × target matrix', () => {
  for (const actorRole of ROLES) {
    for (const targetRole of ROLES) {
      const canSuspend = EXPECTED_SUSPEND[actorRole].includes(targetRole);
      it(`${actorRole} → suspend ${targetRole} = ${canSuspend ? 'ALLOW' : 'DENY'}`, () => {
        const run = () => assertCanChangeUserStatus(actorOf(actorRole), targetOf(targetRole), 'suspend');
        if (canSuspend) expect(run).not.toThrow();
        else expect(run).toThrow(ForbiddenException);
      });

      const canActivate = EXPECTED_ACTIVATE[actorRole].includes(targetRole);
      it(`${actorRole} → reinstate ${targetRole} = ${canActivate ? 'ALLOW' : 'DENY'}`, () => {
        const run = () => assertCanChangeUserStatus(actorOf(actorRole), targetOf(targetRole), 'activate');
        if (canActivate) expect(run).not.toThrow();
        else expect(run).toThrow(ForbiddenException);
      });
    }
  }

  it.each(ROLES)('no %s can suspend or reinstate their own account', (role) => {
    const self = { id: 7, role };
    expect(() => assertCanChangeUserStatus({ ...self, phone: 'x' } as AuthenticatedUser, self, 'suspend')).toThrow(
      ForbiddenException,
    );
    expect(() => assertCanChangeUserStatus({ ...self, phone: 'x' } as AuthenticatedUser, self, 'activate')).toThrow(
      ForbiddenException,
    );
  });

  it('nobody can suspend or reinstate a SUPER_ADMIN (keeps the future PLATFORM_OWNER out of operational reach)', () => {
    for (const role of ROLES) {
      expect(SUSPENDABLE_TARGETS[role].has(UserRole.SUPER_ADMIN)).toBe(false);
      expect(REACTIVATABLE_TARGETS[role].has(UserRole.SUPER_ADMIN)).toBe(false);
    }
  });

  it('nobody can lift an ADMIN emergency freeze — reserved for PLATFORM_OWNER governance', () => {
    for (const role of ROLES) expect(REACTIVATABLE_TARGETS[role].has(UserRole.ADMIN)).toBe(false);
  });

  it('ADMIN can never act on another ADMIN, a MODERATOR or a SUPPORT account', () => {
    for (const target of [UserRole.ADMIN, UserRole.MODERATOR, UserRole.SUPPORT, UserRole.SUPER_ADMIN]) {
      expect(() => assertCanChangeUserStatus(actorOf(UserRole.ADMIN), targetOf(target), 'suspend')).toThrow(
        ForbiddenException,
      );
    }
  });
});

describe('AdminService.suspendUser / activateUser (Phase 15B)', () => {
  let service: AdminService;
  let prisma: {
    $transaction: jest.Mock;
    user: { findFirst: jest.Mock; updateMany: jest.Mock; findUniqueOrThrow: jest.Mock };
    refreshToken: { updateMany: jest.Mock };
    authSession: { updateMany: jest.Mock };
    auditLog: { create: jest.Mock };
  };

  const superAdmin = actorOf(UserRole.SUPER_ADMIN);
  const admin = actorOf(UserRole.ADMIN);

  function targetRow(role: UserRole, status: UserStatus = UserStatus.ACTIVE) {
    return { id: 2, role, status, deletedAt: null, passwordHash: 'h', sessionVersion: 0 };
  }

  beforeEach(async () => {
    prisma = {
      $transaction: jest.fn((fn: (tx: unknown) => unknown) => fn(prisma)),
      user: {
        findFirst: jest.fn(),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        findUniqueOrThrow: jest.fn(),
      },
      // Every token of the target, in one statement (no session-less sweep since 15E.4e.1).
      refreshToken: { updateMany: jest.fn().mockResolvedValue({ count: 3 }) },
      authSession: { updateMany: jest.fn().mockResolvedValue({ count: 2 }) },
      auditLog: { create: jest.fn() },
    };
    const moduleRef = await Test.createTestingModule({
      providers: [
        AdminService,
        { provide: PrismaService, useValue: prisma },
        { provide: ReviewsService, useValue: {} },
      ],
    }).compile();
    service = moduleRef.get(AdminService);
  });

  it('suspends with compare-and-set on status AND role, bumps sessionVersion and revokes every session and refresh token', async () => {
    prisma.user.findFirst.mockResolvedValue(targetRow(UserRole.CUSTOMER));
    prisma.user.findUniqueOrThrow.mockResolvedValue({ ...targetRow(UserRole.CUSTOMER), status: UserStatus.SUSPENDED });

    const result = await service.suspendUser(2, admin, 'Spam accounts');

    expect(prisma.user.updateMany).toHaveBeenCalledWith({
      where: { id: 2, status: UserStatus.ACTIVE, role: UserRole.CUSTOMER, deletedAt: null },
      data: { status: UserStatus.SUSPENDED, sessionVersion: { increment: 1 } },
    });
    expect(prisma.authSession.updateMany).toHaveBeenCalledWith({
      where: { userId: 2, revokedAt: null },
      data: { revokedAt: expect.any(Date), revokedReason: SessionRevokedReason.SUSPENDED },
    });
    expect(prisma.refreshToken.updateMany).toHaveBeenCalledTimes(1);
    expect(prisma.refreshToken.updateMany).toHaveBeenCalledWith({
      where: { userId: 2, revokedAt: null },
      data: { revokedAt: expect.any(Date) },
    });
    expect(prisma.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        actorId: 1,
        action: AuditAction.SUSPEND,
        entityType: 'User',
        entityId: 2,
        note: 'Spam accounts',
        after: expect.objectContaining({ kind: 'SUSPENSION', sessionsRevoked: 2, tokensRevoked: 3 }),
      }),
    });
    expect(result).not.toHaveProperty('passwordHash');
  });

  it('records a SUPER_ADMIN suspending an ADMIN as an EMERGENCY_FREEZE', async () => {
    prisma.user.findFirst.mockResolvedValue(targetRow(UserRole.ADMIN));
    prisma.user.findUniqueOrThrow.mockResolvedValue({ ...targetRow(UserRole.ADMIN), status: UserStatus.SUSPENDED });

    await service.suspendUser(2, superAdmin, 'Credential compromise suspected');

    expect(prisma.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ after: expect.objectContaining({ kind: 'EMERGENCY_FREEZE' }) }),
    });
  });

  it('ADMIN → suspend SUPER_ADMIN = DENY, with no write of any kind', async () => {
    prisma.user.findFirst.mockResolvedValue(targetRow(UserRole.SUPER_ADMIN));

    await expect(service.suspendUser(2, admin, 'x')).rejects.toThrow(ForbiddenException);
    expect(prisma.user.updateMany).not.toHaveBeenCalled();
    expect(prisma.refreshToken.updateMany).not.toHaveBeenCalled();
    expect(prisma.authSession.updateMany).not.toHaveBeenCalled();
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });

  it('SUPER_ADMIN → suspend SUPER_ADMIN = DENY', async () => {
    prisma.user.findFirst.mockResolvedValue(targetRow(UserRole.SUPER_ADMIN));
    await expect(service.suspendUser(2, superAdmin, 'x')).rejects.toThrow(ForbiddenException);
    expect(prisma.user.updateMany).not.toHaveBeenCalled();
  });

  it('ADMIN → suspend ADMIN = DENY', async () => {
    prisma.user.findFirst.mockResolvedValue(targetRow(UserRole.ADMIN));
    await expect(service.suspendUser(2, admin, 'x')).rejects.toThrow(ForbiddenException);
    expect(prisma.user.updateMany).not.toHaveBeenCalled();
  });

  it('nobody → suspend self = DENY', async () => {
    prisma.user.findFirst.mockResolvedValue({ ...targetRow(UserRole.SUPER_ADMIN), id: 1 });
    await expect(service.suspendUser(1, superAdmin, 'x')).rejects.toThrow(ForbiddenException);
    expect(prisma.user.updateMany).not.toHaveBeenCalled();
  });

  it('409s, writing nothing further, when the account changed between read and write (lost race)', async () => {
    prisma.user.findFirst.mockResolvedValue(targetRow(UserRole.CUSTOMER));
    prisma.user.updateMany.mockResolvedValue({ count: 0 });

    await expect(service.suspendUser(2, admin, 'x')).rejects.toThrow(ConflictException);
    expect(prisma.refreshToken.updateMany).not.toHaveBeenCalled();
    expect(prisma.authSession.updateMany).not.toHaveBeenCalled();
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });

  it('409s on suspending an account that is not ACTIVE', async () => {
    prisma.user.findFirst.mockResolvedValue(targetRow(UserRole.CUSTOMER, UserStatus.SUSPENDED));
    await expect(service.suspendUser(2, admin, 'x')).rejects.toThrow(ConflictException);
    expect(prisma.user.updateMany).not.toHaveBeenCalled();
  });

  it('reinstates via compare-and-set and audits RESTORE with the reason', async () => {
    prisma.user.findFirst.mockResolvedValue(targetRow(UserRole.MODERATOR, UserStatus.SUSPENDED));
    prisma.user.findUniqueOrThrow.mockResolvedValue(targetRow(UserRole.MODERATOR));

    await service.activateUser(2, superAdmin, 'Investigation closed');

    expect(prisma.user.updateMany).toHaveBeenCalledWith({
      where: { id: 2, status: UserStatus.SUSPENDED, role: UserRole.MODERATOR, deletedAt: null },
      data: { status: UserStatus.ACTIVE },
    });
    // Reinstatement revives nothing: no session or token is touched.
    expect(prisma.authSession.updateMany).not.toHaveBeenCalled();
    expect(prisma.refreshToken.updateMany).not.toHaveBeenCalled();
    expect(prisma.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ action: AuditAction.RESTORE, note: 'Investigation closed' }),
    });
  });

  it('SUPER_ADMIN cannot lift an emergency freeze of an ADMIN', async () => {
    prisma.user.findFirst.mockResolvedValue(targetRow(UserRole.ADMIN, UserStatus.SUSPENDED));
    await expect(service.activateUser(2, superAdmin, 'x')).rejects.toThrow(
      'An emergency-frozen ADMIN can only be reinstated by the platform owner',
    );
    expect(prisma.user.updateMany).not.toHaveBeenCalled();
  });

  it('ADMIN cannot reinstate a MODERATOR (staff accounts are SUPER_ADMIN business)', async () => {
    prisma.user.findFirst.mockResolvedValue(targetRow(UserRole.MODERATOR, UserStatus.SUSPENDED));
    await expect(service.activateUser(2, admin, 'x')).rejects.toThrow(ForbiddenException);
  });

  it('409s on reinstating an account that is not SUSPENDED', async () => {
    prisma.user.findFirst.mockResolvedValue(targetRow(UserRole.CUSTOMER, UserStatus.ACTIVE));
    await expect(service.activateUser(2, admin, 'x')).rejects.toThrow(ConflictException);
  });
});
