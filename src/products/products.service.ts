import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { BusinessStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuthenticatedUser } from '../auth/strategies/jwt.strategy';
import { CreateMenuItemDto } from './dto/create-menu-item.dto';
import { UpdateMenuItemDto } from './dto/update-menu-item.dto';

function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/['’ʻʼ`]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

// ============================================================================
// MENU  (GET/POST /businesses/:id/menu, PATCH/DELETE /menu/:id)
//
// There is no separate MenuItem model — Product already covers exactly this
// (name, description, price, imageUrl, businessId, plus catalog fields the
// menu UI doesn't need yet like unit/currency/sortOrder). Adding a second,
// near-identical model would just be two sources of truth for the same
// "things a business sells" concept: Product stays the one table, "menu" is
// just the product-catalog view of it.
// ============================================================================

@Injectable()
export class ProductsService {
  constructor(private readonly prisma: PrismaService) {}

  // PUBLIC list. Scoped to APPROVED businesses on purpose: GET /businesses/:id
  // already 404s for anything else, so serving a DRAFT/PENDING/REJECTED/
  // SUSPENDED/HIDDEN business's catalog here would publish the one part of an
  // unpublished listing that the rest of the public API withholds. Owners read
  // their own catalog through findForOwner instead, which has no status filter.
  async findForBusiness(businessId: number) {
    const business = await this.prisma.business.findFirst({
      where: { id: businessId, status: BusinessStatus.APPROVED, deletedAt: null },
    });
    if (!business) {
      throw new NotFoundException(`Business ${businessId} not found`);
    }

    return this.prisma.product.findMany({
      where: { businessId, isActive: true, deletedAt: null },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
    });
  }

  // OWNER list — the management view. Includes isActive: false items (the
  // public list hides them, so without this an owner could deactivate an item
  // and never see it again to reactivate it) and ignores business status, since
  // a newly submitted business sits at PENDING and still needs its catalog
  // filled in before approval.
  async findForOwner(businessId: number, user: AuthenticatedUser) {
    const business = await this.getBusinessOrThrow(businessId);
    this.assertOwner(business, user);

    return this.prisma.product.findMany({
      where: { businessId, deletedAt: null },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
    });
  }

  async create(businessId: number, user: AuthenticatedUser, dto: CreateMenuItemDto) {
    const business = await this.getBusinessOrThrow(businessId);
    this.assertOwner(business, user);

    const slug = await this.generateUniqueSlug(businessId, dto.name);
    if (dto.categoryId != null) await this.assertCategoryExists(dto.categoryId);

    return this.prisma.product.create({
      data: {
        businessId,
        name: dto.name,
        slug,
        description: dto.description,
        imageUrl: dto.photo,
        price: dto.price,
        type: dto.type,
        categoryId: dto.categoryId,
      },
    });
  }

  async update(id: number, user: AuthenticatedUser, dto: UpdateMenuItemDto) {
    const product = await this.getOwnedProduct(id, user);
    if (dto.categoryId != null) await this.assertCategoryExists(dto.categoryId);

    // Every field is left undefined when absent so Prisma skips it — a PATCH
    // that only flips isActive must not blank out name/price/description.
    return this.prisma.product.update({
      where: { id: product.id },
      data: {
        name: dto.name,
        description: dto.description,
        imageUrl: dto.photo,
        price: dto.price,
        type: dto.type,
        categoryId: dto.categoryId,
        isAvailable: dto.isAvailable,
        isActive: dto.isActive,
      },
    });
  }

  // Soft delete, consistent with every other entity in this schema.
  async remove(id: number, user: AuthenticatedUser) {
    const product = await this.getOwnedProduct(id, user);
    await this.prisma.product.update({ where: { id: product.id }, data: { deletedAt: new Date() } });
    return { success: true };
  }

  private async getOwnedProduct(id: number, user: AuthenticatedUser) {
    const product = await this.prisma.product.findFirst({
      where: { id, deletedAt: null },
      include: { business: true },
    });
    if (!product) {
      throw new NotFoundException(`Menu item ${id} not found`);
    }
    this.assertOwner(product.business, user);
    return product;
  }

  // Same validation BusinessesService.update does for its categoryId, so a
  // typo'd id fails loudly instead of silently landing a dangling reference.
  private async assertCategoryExists(categoryId: number) {
    const category = await this.prisma.category.findFirst({ where: { id: categoryId, deletedAt: null } });
    if (!category) {
      throw new NotFoundException(`Category ${categoryId} not found`);
    }
  }

  private async getBusinessOrThrow(id: number) {
    const business = await this.prisma.business.findFirst({ where: { id, deletedAt: null } });
    if (!business) {
      throw new NotFoundException(`Business ${id} not found`);
    }
    return business;
  }

  // Ownership only, same rule as BusinessesService (Phase 15B, D-74). The old
  // "owner OR rank >= MODERATOR" bypass let any moderator rewrite any
  // catalog. Cross-business catalog editing by ADMIN is not offered at all
  // until the capability phase decides whether it is wanted (15C open #9).
  private assertOwner(business: { ownerId: number | null }, user: AuthenticatedUser) {
    if (business.ownerId === null || business.ownerId !== user.id) {
      throw new ForbiddenException('You do not have permission to manage this menu');
    }
  }

  private async generateUniqueSlug(businessId: number, name: string): Promise<string> {
    const base = slugify(name) || 'item';
    let slug = base;
    let suffix = 1;
    while (await this.prisma.product.findUnique({ where: { businessId_slug: { businessId, slug } } })) {
      suffix += 1;
      slug = `${base}-${suffix}`;
    }
    return slug;
  }
}
