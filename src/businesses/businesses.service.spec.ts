import { NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { BusinessStatus } from '@prisma/client';
import { BusinessesService } from './businesses.service';
import { PrismaService } from '../prisma/prisma.service';
import { OwnerService } from '../owner/owner.service';

describe('BusinessesService', () => {
  let service: BusinessesService;
  let prisma: {
    $transaction: jest.Mock;
    business: { findMany: jest.Mock; count: jest.Mock; findFirst: jest.Mock };
    review: { findMany: jest.Mock };
  };

  beforeEach(async () => {
    prisma = {
      $transaction: jest.fn((ops: Promise<unknown>[]) => Promise.all(ops)),
      business: { findMany: jest.fn(), count: jest.fn(), findFirst: jest.fn() },
      review: { findMany: jest.fn() },
    };

    const moduleRef = await Test.createTestingModule({
      providers: [
        BusinessesService,
        { provide: PrismaService, useValue: prisma },
        { provide: OwnerService, useValue: {} },
      ],
    }).compile();

    service = moduleRef.get(BusinessesService);
  });

  describe('findAll', () => {
    it('paginates approved, non-deleted businesses', async () => {
      const rows = [{ id: 1, slug: 'soy-milliy-taomlar', name: 'Soy milliy taomlar', branches: [] }];
      prisma.business.findMany.mockResolvedValue(rows);
      prisma.business.count.mockResolvedValue(1);

      const result = await service.findAll({} as any);

      expect(result.meta).toEqual({ page: 1, limit: 20, total: 1, totalPages: 1 });
      expect(result.data).toHaveLength(1);
      expect(prisma.business.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ status: BusinessStatus.APPROVED, deletedAt: null }),
        }),
      );
    });

    it('filters by search term (case-insensitive contains)', async () => {
      prisma.business.findMany.mockResolvedValue([]);
      prisma.business.count.mockResolvedValue(0);

      await service.findAll({ search: 'osh' } as any);

      const call = prisma.business.findMany.mock.calls[0][0];
      expect(call.where.name).toEqual({ contains: 'osh', mode: 'insensitive' });
    });
  });

  describe('findOne', () => {
    it('throws NotFoundException when no matching approved business exists', async () => {
      prisma.business.findFirst.mockResolvedValue(null);

      await expect(service.findOne('missing-slug')).rejects.toThrow(NotFoundException);
    });

    it('resolves by numeric id or by slug', async () => {
      prisma.business.findFirst.mockResolvedValue({
        id: 4,
        businessType: { catalogEnabled: true, eventsEnabled: true },
        products: [{ id: 1 }],
        events: [{ id: 1 }],
      });
      prisma.review.findMany.mockResolvedValue([]);

      const bySlug = await service.findOne('soy-milliy-taomlar');
      expect(prisma.business.findFirst.mock.calls[0][0].where).toMatchObject({ slug: 'soy-milliy-taomlar' });
      expect(bySlug.id).toBe(4);

      await service.findOne('4');
      expect(prisma.business.findFirst.mock.calls[1][0].where).toMatchObject({ id: 4 });
    });

    // Phase 16F.2: a numeric value is an ID first; only if no business has
    // that ID is it tried as a slug (a legacy all-digit slug from before
    // slugBase made them impossible).
    describe('numeric values (id first, legacy numeric slug second)', () => {
      const found = {
        id: 12,
        slug: '777',
        businessType: { catalogEnabled: true, eventsEnabled: true },
        products: [],
        events: [],
      };

      beforeEach(() => {
        prisma.review.findMany.mockResolvedValue([]);
      });

      it('resolves a matching ID with a single ID query', async () => {
        prisma.business.findFirst.mockResolvedValueOnce({ ...found, id: 777, slug: 'soy' });

        const result = await service.findOne('777');

        expect(result.id).toBe(777);
        expect(prisma.business.findFirst).toHaveBeenCalledTimes(1);
        expect(prisma.business.findFirst.mock.calls[0][0].where).toMatchObject({ id: 777 });
      });

      it('falls back to the slug when no business has that ID', async () => {
        prisma.business.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce(found);

        const result = await service.findOne('777');

        expect(result.id).toBe(12);
        expect(prisma.business.findFirst).toHaveBeenCalledTimes(2);
        expect(prisma.business.findFirst.mock.calls[1][0].where).toMatchObject({ slug: '777' });
        expect(prisma.business.findFirst.mock.calls[1][0].where).not.toHaveProperty('id');
      });

      it('keeps the visibility rules on the slug fallback', async () => {
        prisma.business.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce(found);

        await service.findOne('777');

        expect(prisma.business.findFirst.mock.calls[1][0].where).toMatchObject({
          slug: '777',
          status: BusinessStatus.APPROVED,
          deletedAt: null,
        });
      });

      it('answers 404 when neither the ID nor the slug matches', async () => {
        prisma.business.findFirst.mockResolvedValue(null);

        await expect(service.findOne('777')).rejects.toThrow(NotFoundException);
        expect(prisma.business.findFirst).toHaveBeenCalledTimes(2);
      });

      it('does not double-query a non-numeric slug', async () => {
        prisma.business.findFirst.mockResolvedValue(null);

        await expect(service.findOne('soy-milliy-taomlar')).rejects.toThrow(NotFoundException);
        expect(prisma.business.findFirst).toHaveBeenCalledTimes(1);
      });
    });

    it('hides products/events when the business type disables them', async () => {
      prisma.business.findFirst.mockResolvedValue({
        id: 5,
        businessType: { catalogEnabled: false, eventsEnabled: false },
        products: [{ id: 1 }],
        events: [{ id: 1 }],
      });
      prisma.review.findMany.mockResolvedValue([]);

      const result = await service.findOne('5');

      expect(result.products).toEqual([]);
      expect(result.events).toEqual([]);
    });
  });
});
