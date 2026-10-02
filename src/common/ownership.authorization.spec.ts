import { ForbiddenException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AuditAction, UserRole } from '@prisma/client';
import { BusinessesController } from '../businesses/businesses.controller';
import { BusinessesService } from '../businesses/businesses.service';
import { EventsController } from '../events/events.controller';
import { ReviewsController } from '../reviews/reviews.controller';
import { ReviewsService } from '../reviews/reviews.service';
import { AdminService } from '../admin/admin.service';
import { PrismaService } from '../prisma/prisma.service';
import { OwnerService } from '../owner/owner.service';
import { HealthScoreService } from '../health-score/health-score.service';
import { decide, ruleOf } from '../authz/decide';
import { AuthenticatedUser } from '../auth/strategies/jwt.strategy';
import { runWithRequestContext } from './request-context/request-context';

// Phase 15B (D-74): business content belongs to its owner. Every role is
// exercised against a business it does NOT own (must be refused — no rank
// bypass for MODERATOR/SUPPORT/ADMIN/SUPER_ADMIN) and against one it DOES own
// (allowed — ownership, not role, decides). Staff cross-business edits exist
// only on the audited /admin routes, covered at the bottom.
const ALL_ROLES = [
  UserRole.CUSTOMER,
  UserRole.BUSINESS_OWNER,
  UserRole.SUPPORT,
  UserRole.MODERATOR,
  UserRole.ADMIN,
  UserRole.SUPER_ADMIN,
];
const OWNER_ID = 7;
const OTHER_ID = 30;
const as = (role: UserRole, id = OTHER_ID): AuthenticatedUser => ({ id, phone: `+99890000${id}`, role });

describe('Owner routes require business.manage_own (ownership checked in the service)', () => {
  const routes: Array<[string, new (...args: never[]) => unknown, (...args: never[]) => unknown]> = [
    ['PATCH /businesses/:id', BusinessesController, BusinessesController.prototype.update],
    ['PUT /businesses/:id/hours', BusinessesController, BusinessesController.prototype.updateHours],
    ['POST /events', EventsController, EventsController.prototype.create],
    ['POST /reviews/:id/reply', ReviewsController, ReviewsController.prototype.reply],
    ['PATCH /reviews/:id/reply', ReviewsController, ReviewsController.prototype.replyPatch],
  ];

  it.each(routes)('%s requires exactly business.manage_own', (_r, controller, handler) => {
    expect(ruleOf(controller, handler)).toEqual({ kind: 'capability', capabilities: ['business.manage_own'] });
  });

  it.each(routes)('%s: CUSTOMER, SUPPORT and platform staff (MODERATOR, ADMIN, SUPER_ADMIN) are refused at the route — no owner capability (D-75, 15D.2)', (_r, controller, handler) => {
    const rule = ruleOf(controller, handler);
    for (const role of [UserRole.SUPPORT, UserRole.MODERATOR, UserRole.CUSTOMER, UserRole.ADMIN, UserRole.SUPER_ADMIN]) expect(decide(rule, role)).toBe('forbidden');
    expect(decide(rule, UserRole.BUSINESS_OWNER)).toBe('allow');
    expect(decide(rule, null)).toBe('unauthenticated');
  });
});

describe('BusinessesService — profile and hours are owner-only', () => {
  let service: BusinessesService;
  let prisma: {
    $transaction: jest.Mock;
    business: { findFirst: jest.Mock; update: jest.Mock };
    category: { findFirst: jest.Mock };
    branch: { findFirst: jest.Mock };
    branchHour: { findMany: jest.Mock; deleteMany: jest.Mock; createMany: jest.Mock };
  };

  beforeEach(async () => {
    prisma = {
      $transaction: jest.fn((fn: (tx: unknown) => unknown) => fn(prisma)),
      business: {
        findFirst: jest.fn().mockResolvedValue({ id: 5, ownerId: OWNER_ID }),
        update: jest.fn().mockResolvedValue({ id: 5 }),
      },
      category: { findFirst: jest.fn() },
      branch: { findFirst: jest.fn().mockResolvedValue({ id: 50 }) },
      branchHour: { findMany: jest.fn().mockResolvedValue([]), deleteMany: jest.fn(), createMany: jest.fn() },
    };
    const moduleRef = await Test.createTestingModule({
      providers: [BusinessesService, { provide: PrismaService, useValue: prisma }, { provide: OwnerService, useValue: {} }],
    }).compile();
    service = moduleRef.get(BusinessesService);
  });

  it.each(ALL_ROLES)("%s editing a business it doesn't own = DENY", async (role) => {
    await expect(service.update(5, as(role), { name: 'Hijacked' })).rejects.toThrow(ForbiddenException);
    expect(prisma.business.update).not.toHaveBeenCalled();
  });

  it.each(ALL_ROLES)("%s replacing hours of a business it doesn't own = DENY", async (role) => {
    await expect(service.updateHours(5, as(role), [{ dayOfWeek: 1 }])).rejects.toThrow(ForbiddenException);
    expect(prisma.branchHour.deleteMany).not.toHaveBeenCalled();
  });

  it.each(ALL_ROLES)('%s editing a business it owns = ALLOW', async (role) => {
    await service.update(5, as(role, OWNER_ID), { name: 'New name' });
    expect(prisma.business.update).toHaveBeenCalledWith({ where: { id: 5 }, data: { name: 'New name' } });
  });

  it('an ownerless (unclaimed) business is editable by nobody through this route', async () => {
    prisma.business.findFirst.mockResolvedValue({ id: 5, ownerId: null });
    for (const role of ALL_ROLES) {
      await expect(service.update(5, as(role), { name: 'x' })).rejects.toThrow(ForbiddenException);
    }
  });

  it('the owner replaces hours inside one transaction', async () => {
    await service.updateHours(5, as(UserRole.BUSINESS_OWNER, OWNER_ID), [{ dayOfWeek: 1, openTime: '09:00' }]);
    expect(prisma.branchHour.deleteMany).toHaveBeenCalledWith({ where: { branchId: 50 } });
    expect(prisma.branchHour.createMany).toHaveBeenCalled();
  });
});

describe('ReviewsService.reply — only the business owner speaks as the business', () => {
  let service: ReviewsService;
  let prisma: { review: { findFirst: jest.Mock }; reviewReply: { create: jest.Mock } };

  beforeEach(async () => {
    prisma = {
      review: {
        findFirst: jest.fn().mockResolvedValue({ id: 3, branch: { businessId: 5, business: { ownerId: OWNER_ID } } }),
      },
      reviewReply: { create: jest.fn().mockResolvedValue({ id: 1 }) },
    };
    const moduleRef = await Test.createTestingModule({
      providers: [
        ReviewsService,
        { provide: PrismaService, useValue: prisma },
        { provide: HealthScoreService, useValue: { recalculateSafely: jest.fn() } },
      ],
    }).compile();
    service = moduleRef.get(ReviewsService);
  });

  it.each(ALL_ROLES)("%s replying on a business it doesn't own = DENY", async (role) => {
    await expect(service.reply(3, as(role), { body: 'Thanks!' })).rejects.toThrow(ForbiddenException);
    expect(prisma.reviewReply.create).not.toHaveBeenCalled();
  });

  it('the owner can reply', async () => {
    await service.reply(3, as(UserRole.BUSINESS_OWNER, OWNER_ID), { body: 'Thanks!' });
    expect(prisma.reviewReply.create).toHaveBeenCalled();
  });
});

describe('AdminService staff edits — the audited cross-business path', () => {
  let service: AdminService;
  let prisma: {
    $transaction: jest.Mock;
    business: { findFirst: jest.Mock; update: jest.Mock };
    category: { findFirst: jest.Mock };
    branch: { findFirst: jest.Mock };
    branchHour: { findMany: jest.Mock; deleteMany: jest.Mock; createMany: jest.Mock };
    auditLog: { create: jest.Mock };
  };

  beforeEach(async () => {
    prisma = {
      $transaction: jest.fn((fn: (tx: unknown) => unknown) => fn(prisma)),
      business: {
        findFirst: jest.fn().mockResolvedValue({ id: 5, ownerId: OWNER_ID, name: 'Old', website: null }),
        update: jest.fn().mockResolvedValue({ id: 5, name: 'New', website: 'https://new.uz' }),
      },
      category: { findFirst: jest.fn() },
      branch: { findFirst: jest.fn().mockResolvedValue({ id: 50 }) },
      branchHour: {
        findMany: jest
          .fn()
          .mockResolvedValueOnce([{ dayOfWeek: 1, openTime: '08:00', closeTime: '17:00', isClosed: false, is24Hours: false }])
          .mockResolvedValueOnce([{ dayOfWeek: 1, openTime: '09:00', closeTime: '18:00', isClosed: false, is24Hours: false }]),
        deleteMany: jest.fn(),
        createMany: jest.fn(),
      },
      auditLog: { create: jest.fn() },
    };
    const moduleRef = await Test.createTestingModule({
      providers: [AdminService, { provide: PrismaService, useValue: prisma }, { provide: ReviewsService, useValue: {} }],
    }).compile();
    service = moduleRef.get(AdminService);
  });

  it('records actor, actor role, reason, request id, IP, user agent and exactly the changed fields', async () => {
    await runWithRequestContext(
      { requestId: 'req-1', ipAddress: '203.0.113.5', userAgent: 'Mozilla/5.0', actorRole: UserRole.ADMIN },
      () => service.updateBusiness(5, 42, { reason: 'Owner asked by phone', name: 'New', website: 'https://new.uz' }),
    );

    expect(prisma.business.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { name: 'New', website: 'https://new.uz' } }),
    );
    expect(prisma.auditLog.create).toHaveBeenCalledWith({
      data: {
        actorId: 42,
        actorRole: UserRole.ADMIN,
        requestId: 'req-1',
        ipAddress: '203.0.113.5',
        userAgent: 'Mozilla/5.0',
        action: AuditAction.UPDATE,
        entityType: 'Business',
        entityId: 5,
        before: { name: 'Old', website: null },
        after: { name: 'New', website: 'https://new.uz' },
        note: 'Owner asked by phone',
      },
    });
  });

  it('audits a staff hours replacement with before/after and the reason', async () => {
    await service.updateBusinessHours(5, 42, 'Seasonal hours', [{ dayOfWeek: 1, openTime: '09:00', closeTime: '18:00' }]);

    expect(prisma.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        entityType: 'BranchHours',
        entityId: 50,
        note: 'Seasonal hours',
        before: { businessId: 5, hours: [expect.objectContaining({ openTime: '08:00' })] },
        after: { businessId: 5, hours: [expect.objectContaining({ openTime: '09:00' })] },
      }),
    });
  });
});
