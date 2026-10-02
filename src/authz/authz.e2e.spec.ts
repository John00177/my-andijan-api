import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { JwtService } from '@nestjs/jwt';
import { UserRole, UserStatus } from '@prisma/client';
import { AddressInfo } from 'node:net';
import { AppModule } from '../app.module';
import { PrismaService } from '../prisma/prisma.service';
import { AdminService } from '../admin/admin.service';
import { CommandCenterService } from '../command-center/command-center.service';
import { BusinessesService } from '../businesses/businesses.service';
import { OwnerService } from '../owner/owner.service';
import { CategoriesService } from '../categories/categories.service';
import { UploadService } from '../upload/upload.service';

// End-to-end through the REAL AppModule (Phase 15D, D-75): the global
// AuthzGuard, the real passport JwtStrategy (user reloaded per request) and
// the real controllers. Only the database and the services behind the
// probed routes are stubbed, so these requests prove the wiring — 401 vs 403
// vs allowed — on live HTTP, not just on metadata.
process.env.JWT_ACCESS_SECRET = 'e2e-access-secret';

const USERS: Record<number, { id: number; phone: string; role: UserRole }> = {
  1: { id: 1, phone: '+998900000001', role: UserRole.CUSTOMER },
  2: { id: 2, phone: '+998900000002', role: UserRole.BUSINESS_OWNER },
  3: { id: 3, phone: '+998900000003', role: UserRole.SUPPORT },
  4: { id: 4, phone: '+998900000004', role: UserRole.MODERATOR },
  5: { id: 5, phone: '+998900000005', role: UserRole.ADMIN },
  6: { id: 6, phone: '+998900000006', role: UserRole.SUPER_ADMIN },
};

describe('Authorization end-to-end (real AppModule)', () => {
  let app: INestApplication;
  let base: string;
  const tokens: Partial<Record<UserRole, string>> = {};
  const admin = {
    getStats: jest.fn().mockResolvedValue({ ok: 'stats' }),
    findBusinesses: jest.fn().mockResolvedValue({ data: [] }),
    updateBusiness: jest.fn().mockResolvedValue({ ok: 'updated' }),
  };
  const owner = { findMyBusinesses: jest.fn().mockResolvedValue([]) };
  const businesses = { update: jest.fn().mockResolvedValue({ ok: 'updated' }), findAll: jest.fn().mockResolvedValue({ data: [] }) };

  beforeAll(async () => {
    const prisma = {
      user: {
        findUnique: jest.fn(async ({ where }: { where: { id: number } }) =>
          USERS[where.id] ? { ...USERS[where.id], status: UserStatus.ACTIVE, deletedAt: null, sessionVersion: 0 } : null,
        ),
      },
      $connect: jest.fn(),
      $disconnect: jest.fn(),
      onModuleInit: jest.fn(),
      onModuleDestroy: jest.fn(),
    };
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PrismaService)
      .useValue(prisma)
      .overrideProvider(AdminService)
      .useValue(admin)
      .overrideProvider(BusinessesService)
      .useValue(businesses)
      .overrideProvider(OwnerService)
      .useValue(owner)
      .overrideProvider(CommandCenterService)
      .useValue({})
      .overrideProvider(CategoriesService)
      .useValue({ findTree: jest.fn().mockResolvedValue([]) })
      .overrideProvider(UploadService)
      .useValue({})
      .compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.listen(0, '127.0.0.1');
    base = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;

    const jwt = new JwtService({});
    for (const user of Object.values(USERS)) {
      tokens[user.role] = await jwt.signAsync(
        { sub: user.id, phone: user.phone, role: user.role, sv: 0 },
        { secret: process.env.JWT_ACCESS_SECRET },
      );
    }
  });

  afterAll(async () => {
    await app?.close();
  });

  const call = (method: string, path: string, role?: UserRole, body?: unknown) =>
    fetch(`${base}${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(role ? { Authorization: `Bearer ${tokens[role]}` } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    }).then((r) => r.status);

  it('public routes stay open to anonymous callers', async () => {
    expect(await call('GET', '/categories')).toBe(200);
    expect(await call('GET', '/businesses')).toBe(200);
  });

  it('a capability route is 401 anonymous and 401 with a forged token', async () => {
    expect(await call('GET', '/admin/stats')).toBe(401);
    const res = await fetch(`${base}/admin/stats`, { headers: { Authorization: 'Bearer not.a.jwt' } });
    expect(res.status).toBe(401);
  });

  it.each([
    [UserRole.CUSTOMER, 403],
    [UserRole.BUSINESS_OWNER, 403],
    [UserRole.SUPPORT, 403],
    [UserRole.MODERATOR, 403],
    [UserRole.ADMIN, 200],
    [UserRole.SUPER_ADMIN, 200],
  ])('GET /admin/stats (analytics.platform) as %s → %s', async (role, status) => {
    expect(await call('GET', '/admin/stats', role)).toBe(status);
  });

  it.each([
    [UserRole.CUSTOMER, 403],
    [UserRole.BUSINESS_OWNER, 403],
    [UserRole.SUPPORT, 403],
    [UserRole.MODERATOR, 200],
    [UserRole.ADMIN, 200],
    [UserRole.SUPER_ADMIN, 200],
  ])('GET /admin/businesses (business.review) as %s → %s', async (role, status) => {
    expect(await call('GET', '/admin/businesses', role)).toBe(status);
  });

  it.each([
    [UserRole.CUSTOMER, 403],
    [UserRole.BUSINESS_OWNER, 200],
    [UserRole.SUPPORT, 403],
    [UserRole.MODERATOR, 403],
    [UserRole.ADMIN, 403],
    [UserRole.SUPER_ADMIN, 403],
  ])('PATCH /businesses/:id (business.manage_own) as %s → %s', async (role, status) => {
    expect(await call('PATCH', '/businesses/5', role, { name: 'X' })).toBe(status);
  });

  // Phase 15D.2: platform staff hold no owner capability — the owner
  // dashboard is BUSINESS_OWNER only, refused at the guard for every staff role.
  it.each([
    [UserRole.CUSTOMER, 403],
    [UserRole.BUSINESS_OWNER, 200],
    [UserRole.SUPPORT, 403],
    [UserRole.MODERATOR, 403],
    [UserRole.ADMIN, 403],
    [UserRole.SUPER_ADMIN, 403],
  ])('GET /me/businesses (business.manage_own) as %s → %s', async (role, status) => {
    expect(await call('GET', '/me/businesses', role)).toBe(status);
  });

  // …while staff keep administering other owners' listings through /admin
  // with the explicit platform capability `business.edit_any`.
  it.each([
    [UserRole.CUSTOMER, 403],
    [UserRole.BUSINESS_OWNER, 403],
    [UserRole.SUPPORT, 403],
    [UserRole.MODERATOR, 403],
    [UserRole.ADMIN, 200],
    [UserRole.SUPER_ADMIN, 200],
  ])('PATCH /admin/businesses/:id (business.edit_any) as %s → %s', async (role, status) => {
    expect(await call('PATCH', '/admin/businesses/5', role, { name: 'X', reason: 'e2e' })).toBe(status);
  });

  it('an authenticated-only route needs a session but no capability', async () => {
    expect(await call('GET', '/favorites')).toBe(401);
  });
});
