import { NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { BusinessStatus, Prisma, UserRole } from '@prisma/client';
import { AdminController } from './admin.controller';
import { AdminService } from './admin.service';
import { PrismaService } from '../prisma/prisma.service';
import { ReviewsService } from '../reviews/reviews.service';

// Phase 16E: GET /admin/businesses/:id — one listing in full for the review
// drawer. Route authorization (business.review = MODERATOR, ADMIN,
// SUPER_ADMIN) is proven on the real controller metadata in
// business-ops.authorization.spec.ts and the route snapshot.
describe('AdminService.findBusinessById — review drawer detail', () => {
  let service: AdminService;
  let prisma: { business: { findFirst: jest.Mock } };

  /** A PENDING listing as Prisma would return it for the query below. */
  const detail = {
    id: 5,
    slug: 'soy-milliy-taomlar',
    name: 'Soy milliy taomlar',
    status: BusinessStatus.PENDING,
    deletedAt: null,
    owner: { id: 7, fullName: 'Sardor Aliyev' },
    category: { id: 1, slug: 'food', nameUz: 'Ovqatlanish' },
    businessType: { id: 2, slug: 'restaurant', nameUz: 'Restoran' },
    branches: [
      {
        id: 11,
        name: 'Markaziy filial',
        slug: 'markaziy',
        address: 'Bobur shoh ko‘chasi 1',
        landmark: 'Bobur xiyoboni yonida',
        phone: '+998900000001',
        phoneAlt: '+998900000002',
        lat: new Prisma.Decimal('40.78250000'),
        lng: new Prisma.Decimal('72.34420000'),
        isPrimary: true,
        isActive: true,
        district: { id: 1, slug: 'andijon', nameUz: 'Andijon' },
        city: { id: 3, slug: 'andijon-shahri', nameUz: 'Andijon shahri' },
        hours: [
          { dayOfWeek: 0, openTime: '10:00', closeTime: '20:00', isClosed: false, is24Hours: false },
          { dayOfWeek: 1, openTime: null, closeTime: null, isClosed: false, is24Hours: true },
          { dayOfWeek: 6, openTime: null, closeTime: null, isClosed: true, is24Hours: false },
        ],
        photos: [
          { url: 'https://cdn.example/1.jpg', thumbUrl: 'https://cdn.example/1-t.jpg', caption: 'Zal', isPrimary: true, sortOrder: 0 },
          { url: 'https://cdn.example/2.jpg', thumbUrl: null, caption: null, isPrimary: false, sortOrder: 1 },
        ],
      },
      {
        id: 12,
        name: 'Asaka filiali',
        slug: 'asaka',
        address: 'Asaka, Mustaqillik 5',
        landmark: null,
        phone: '+998900000003',
        phoneAlt: null,
        lat: null,
        lng: null,
        isPrimary: false,
        isActive: true,
        district: { id: 2, slug: 'asaka', nameUz: 'Asaka' },
        city: null,
        hours: [],
        photos: [],
      },
    ],
  };

  beforeEach(async () => {
    prisma = { business: { findFirst: jest.fn().mockResolvedValue(detail) } };
    const moduleRef = await Test.createTestingModule({
      providers: [
        AdminService,
        { provide: PrismaService, useValue: prisma },
        { provide: ReviewsService, useValue: {} },
      ],
    }).compile();
    service = moduleRef.get(AdminService);
  });

  function query() {
    return prisma.business.findFirst.mock.calls[0][0];
  }

  it('returns the full listing — every branch with address, phones, coordinates, hours and photos', async () => {
    await expect(service.findBusinessById(5, UserRole.MODERATOR)).resolves.toBe(detail);
  });

  it('reads any approval status, excluding only soft-deleted listings', async () => {
    await service.findBusinessById(5, UserRole.MODERATOR);

    expect(query().where).toEqual({ id: 5, deletedAt: null });
  });

  it.each([5, 999])('answers 404 when no non-deleted listing matches (id %i: unknown or soft-deleted)', async (id) => {
    prisma.business.findFirst.mockResolvedValueOnce(null);

    await expect(service.findBusinessById(id, UserRole.ADMIN)).rejects.toThrow(NotFoundException);
  });

  describe('owner contact details are shaped by user.pii.read (D-72), as in the queue', () => {
    it('gives a MODERATOR the owner without phone or email', async () => {
      await service.findBusinessById(5, UserRole.MODERATOR);

      expect(query().include.owner).toEqual({ select: { id: true, fullName: true } });
    });

    it.each([UserRole.ADMIN, UserRole.SUPER_ADMIN])('gives %s the owner contact details', async (role) => {
      await service.findBusinessById(5, role);

      expect(query().include.owner).toEqual({ select: { id: true, fullName: true, phone: true, email: true } });
    });
  });

  describe('branch projection', () => {
    it('includes every non-deleted branch, primary first', async () => {
      await service.findBusinessById(5, UserRole.MODERATOR);
      const { branches } = query().include;

      expect(branches.where).toEqual({ deletedAt: null });
      expect(branches.orderBy).toEqual([{ isPrimary: 'desc' }, { createdAt: 'asc' }]);
    });

    it('selects address, landmark, both phones, coordinates, district and city', async () => {
      await service.findBusinessById(5, UserRole.MODERATOR);
      const { select } = query().include.branches;

      expect(select).toMatchObject({
        address: true,
        landmark: true,
        phone: true,
        phoneAlt: true,
        lat: true,
        lng: true,
        isPrimary: true,
        isActive: true,
        district: { select: { id: true, slug: true, nameUz: true } },
        city: { select: { id: true, slug: true, nameUz: true } },
      });
    });

    it('selects opening hours by day, including is24Hours', async () => {
      await service.findBusinessById(5, UserRole.MODERATOR);
      const { hours } = query().include.branches.select;

      expect(hours).toEqual({
        orderBy: { dayOfWeek: 'asc' },
        select: { dayOfWeek: true, openTime: true, closeTime: true, isClosed: true, is24Hours: true },
      });
    });

    it('selects exactly url, thumbnail, caption, primary flag and sort order for photos', async () => {
      await service.findBusinessById(5, UserRole.MODERATOR);
      const { photos } = query().include.branches.select;

      expect(photos.select).toEqual({ url: true, thumbUrl: true, caption: true, isPrimary: true, sortOrder: true });
      expect(photos.orderBy).toEqual([{ sortOrder: 'asc' }, { id: 'asc' }]);
    });
  });

  describe('what it never returns', () => {
    it('never exposes the photo uploader (uploadedById / uploadedBy) or the storage id', async () => {
      await service.findBusinessById(5, UserRole.SUPER_ADMIN);
      const serialized = JSON.stringify(query());

      expect(serialized).not.toContain('uploadedById');
      expect(serialized).not.toContain('uploadedBy');
      expect(serialized).not.toContain('publicId');
    });

    it('includes no products, events, reviews, claims or other relations beyond the projection', async () => {
      await service.findBusinessById(5, UserRole.SUPER_ADMIN);

      expect(Object.keys(query().include).sort()).toEqual(['branches', 'businessType', 'category', 'owner']);
      expect(Object.keys(query().include.branches.select)).not.toEqual(expect.arrayContaining(['reviews']));
    });
  });
});

describe('AdminController.findBusinessById', () => {
  it.each([UserRole.MODERATOR, UserRole.ADMIN])('passes the id and the %s viewer role to the service', async (role) => {
    const adminService = { findBusinessById: jest.fn().mockResolvedValue({ id: 5 }) };
    const controller = new AdminController(adminService as unknown as AdminService);

    await expect(controller.findBusinessById(5, { id: 42, role } as never)).resolves.toEqual({ id: 5 });
    expect(adminService.findBusinessById).toHaveBeenCalledWith(5, role);
  });
});
