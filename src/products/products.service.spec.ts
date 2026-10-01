import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { BusinessStatus, ProductType, UserRole } from '@prisma/client';
import { ProductsService } from './products.service';
import { PrismaService } from '../prisma/prisma.service';
import { AuthenticatedUser } from '../auth/strategies/jwt.strategy';

describe('ProductsService', () => {
  let service: ProductsService;
  let prisma: {
    business: { findFirst: jest.Mock };
    category: { findFirst: jest.Mock };
    product: { findMany: jest.Mock; findFirst: jest.Mock; findUnique: jest.Mock; create: jest.Mock; update: jest.Mock };
  };

  const owner: AuthenticatedUser = { id: 7, phone: '+998901234567', role: UserRole.BUSINESS_OWNER };
  const otherOwner: AuthenticatedUser = { id: 8, phone: '+998901234568', role: UserRole.BUSINESS_OWNER };
  const moderator: AuthenticatedUser = { id: 9, phone: '+998901234569', role: UserRole.MODERATOR };
  const ownedBusiness = { id: 5, ownerId: 7, status: BusinessStatus.APPROVED };

  beforeEach(async () => {
    prisma = {
      business: { findFirst: jest.fn().mockResolvedValue(ownedBusiness) },
      category: { findFirst: jest.fn().mockResolvedValue({ id: 3 }) },
      product: {
        findMany: jest.fn().mockResolvedValue([]),
        findFirst: jest.fn(),
        findUnique: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockImplementation(({ data }) => Promise.resolve({ id: 1, ...data })),
        update: jest.fn().mockImplementation(({ data }) => Promise.resolve({ id: 1, ...data })),
      },
    };

    const moduleRef = await Test.createTestingModule({
      providers: [ProductsService, { provide: PrismaService, useValue: prisma }],
    }).compile();

    service = moduleRef.get(ProductsService);
  });

  describe('findForBusiness (public)', () => {
    it('returns only active, non-deleted items of an APPROVED business', async () => {
      const rows = [{ id: 1, name: 'Osh', isActive: true }];
      prisma.product.findMany.mockResolvedValue(rows);

      const result = await service.findForBusiness(5);

      expect(result).toEqual(rows);
      expect(prisma.business.findFirst).toHaveBeenCalledWith({
        where: { id: 5, status: BusinessStatus.APPROVED, deletedAt: null },
      });
      expect(prisma.product.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { businessId: 5, isActive: true, deletedAt: null } }),
      );
    });

    it('404s for a business that is not APPROVED, without exposing its catalog', async () => {
      prisma.business.findFirst.mockResolvedValue(null);

      await expect(service.findForBusiness(5)).rejects.toThrow(NotFoundException);
      expect(prisma.product.findMany).not.toHaveBeenCalled();
    });
  });

  describe('findForOwner', () => {
    it("includes deactivated items and ignores business status for the business's owner", async () => {
      prisma.business.findFirst.mockResolvedValue({ id: 5, ownerId: 7, status: BusinessStatus.PENDING });

      await service.findForOwner(5, owner);

      expect(prisma.product.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { businessId: 5, deletedAt: null } }),
      );
    });

    it("refuses to list another owner's catalog", async () => {
      await expect(service.findForOwner(5, otherOwner)).rejects.toThrow(ForbiddenException);
      expect(prisma.product.findMany).not.toHaveBeenCalled();
    });

    it('allows staff (MODERATOR and above) to list any catalog', async () => {
      await service.findForOwner(5, moderator);
      expect(prisma.product.findMany).toHaveBeenCalled();
    });

    // SUPPORT clears the route's @Roles(BUSINESS_OWNER) floor because it
    // outranks BUSINESS_OWNER in ROLE_HIERARCHY, so the service layer is the
    // only thing standing between a support agent and someone else's catalog.
    it("refuses a SUPPORT user who does not own the business, even though the guard let them through", async () => {
      const support: AuthenticatedUser = { id: 10, phone: '+998901234570', role: UserRole.SUPPORT };

      await expect(service.findForOwner(5, support)).rejects.toThrow(ForbiddenException);
      expect(prisma.product.findMany).not.toHaveBeenCalled();
    });

    it('404s for a nonexistent business', async () => {
      prisma.business.findFirst.mockResolvedValue(null);
      await expect(service.findForOwner(5, owner)).rejects.toThrow(NotFoundException);
    });
  });

  describe('create', () => {
    it('creates an item with a generated slug, leaving type/category to the model defaults', async () => {
      const result = await service.create(5, owner, { name: 'Osh porsiya', price: 25000 } as any);

      expect(prisma.product.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ businessId: 5, name: 'Osh porsiya', slug: 'osh-porsiya', price: 25000 }),
      });
      expect(result).toEqual(expect.objectContaining({ id: 1 }));
    });

    it('persists an explicit SERVICE type and categoryId', async () => {
      await service.create(5, owner, {
        name: 'Soch olish',
        price: 40000,
        type: ProductType.SERVICE,
        categoryId: 3,
      } as any);

      expect(prisma.category.findFirst).toHaveBeenCalledWith({ where: { id: 3, deletedAt: null } });
      expect(prisma.product.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ type: ProductType.SERVICE, categoryId: 3 }),
      });
    });

    it('404s on an unknown categoryId instead of writing a dangling reference', async () => {
      prisma.category.findFirst.mockResolvedValue(null);

      await expect(service.create(5, owner, { name: 'X', price: 1, categoryId: 999 } as any)).rejects.toThrow(
        NotFoundException,
      );
      expect(prisma.product.create).not.toHaveBeenCalled();
    });

    it("refuses to add an item to another owner's business", async () => {
      await expect(service.create(5, otherOwner, { name: 'X', price: 1 } as any)).rejects.toThrow(ForbiddenException);
      expect(prisma.product.create).not.toHaveBeenCalled();
    });

    it('suffixes the slug when the business already has one with that name', async () => {
      prisma.product.findUnique.mockResolvedValueOnce({ id: 99 }).mockResolvedValueOnce(null);

      await service.create(5, owner, { name: 'Osh', price: 1 } as any);

      expect(prisma.product.create).toHaveBeenCalledWith({ data: expect.objectContaining({ slug: 'osh-2' }) });
    });
  });

  describe('update', () => {
    beforeEach(() => {
      prisma.product.findFirst.mockResolvedValue({ id: 1, businessId: 5, business: ownedBusiness });
    });

    it('deactivates an item without touching its other fields', async () => {
      await service.update(1, owner, { isActive: false } as any);

      expect(prisma.product.update).toHaveBeenCalledWith({
        where: { id: 1 },
        data: {
          name: undefined,
          description: undefined,
          imageUrl: undefined,
          price: undefined,
          type: undefined,
          categoryId: undefined,
          isAvailable: undefined,
          isActive: false,
        },
      });
    });

    it('reactivates an item', async () => {
      await service.update(1, owner, { isActive: true } as any);
      expect(prisma.product.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ isActive: true }) }),
      );
    });

    it('updates name, price, description, image, type and category together', async () => {
      await service.update(1, owner, {
        name: 'Yangi nom',
        price: 30000,
        description: 'Tavsif',
        photo: 'https://example.test/a.jpg',
        type: ProductType.SERVICE,
        categoryId: 3,
      } as any);

      expect(prisma.product.update).toHaveBeenCalledWith({
        where: { id: 1 },
        data: expect.objectContaining({
          name: 'Yangi nom',
          price: 30000,
          description: 'Tavsif',
          imageUrl: 'https://example.test/a.jpg',
          type: ProductType.SERVICE,
          categoryId: 3,
        }),
      });
    });

    it("refuses to update an item on another owner's business", async () => {
      await expect(service.update(1, otherOwner, { name: 'X' } as any)).rejects.toThrow(ForbiddenException);
      expect(prisma.product.update).not.toHaveBeenCalled();
    });

    it('404s for a nonexistent or already-deleted item', async () => {
      prisma.product.findFirst.mockResolvedValue(null);
      await expect(service.update(1, owner, { name: 'X' } as any)).rejects.toThrow(NotFoundException);
    });
  });

  describe('remove', () => {
    it('soft-deletes the item rather than dropping the row', async () => {
      prisma.product.findFirst.mockResolvedValue({ id: 1, businessId: 5, business: ownedBusiness });

      const result = await service.remove(1, owner);

      expect(result).toEqual({ success: true });
      const call = prisma.product.update.mock.calls[0][0];
      expect(call.where).toEqual({ id: 1 });
      expect(call.data.deletedAt).toBeInstanceOf(Date);
    });

    it("refuses to delete another owner's item", async () => {
      prisma.product.findFirst.mockResolvedValue({ id: 1, businessId: 5, business: ownedBusiness });

      await expect(service.remove(1, otherOwner)).rejects.toThrow(ForbiddenException);
      expect(prisma.product.update).not.toHaveBeenCalled();
    });
  });
});
