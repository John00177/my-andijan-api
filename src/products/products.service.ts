import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuthenticatedUser } from '../auth/strategies/jwt.strategy';
import { ROLE_HIERARCHY } from '../common/constants/role-hierarchy';
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

  async findForBusiness(businessId: number) {
    const business = await this.prisma.business.findFirst({ where: { id: businessId, deletedAt: null } });
    if (!business) {
      throw new NotFoundException(`Business ${businessId} not found`);
    }

    return this.prisma.product.findMany({
      where: { businessId, isActive: true, deletedAt: null },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
    });
  }

  async create(businessId: number, user: AuthenticatedUser, dto: CreateMenuItemDto) {
    const business = await this.getBusinessOrThrow(businessId);
    this.assertCanManage(business, user);

    const slug = await this.generateUniqueSlug(businessId, dto.name);

    return this.prisma.product.create({
      data: {
        businessId,
        name: dto.name,
        slug,
        description: dto.description,
        imageUrl: dto.photo,
        price: dto.price,
      },
    });
  }

  async update(id: number, user: AuthenticatedUser, dto: UpdateMenuItemDto) {
    const product = await this.getOwnedProduct(id, user);

    return this.prisma.product.update({
      where: { id: product.id },
      data: {
        name: dto.name,
        description: dto.description,
        imageUrl: dto.photo,
        price: dto.price,
        isAvailable: dto.isAvailable,
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
    this.assertCanManage(product.business, user);
    return product;
  }

  private async getBusinessOrThrow(id: number) {
    const business = await this.prisma.business.findFirst({ where: { id, deletedAt: null } });
    if (!business) {
      throw new NotFoundException(`Business ${id} not found`);
    }
    return business;
  }

  // Owner or ADMIN/MODERATOR/SUPER_ADMIN — same rule as BusinessesService.
  private assertCanManage(business: { ownerId: number | null }, user: AuthenticatedUser) {
    const isOwner = business.ownerId === user.id;
    const isStaff = ROLE_HIERARCHY[user.role] >= ROLE_HIERARCHY[UserRole.MODERATOR];
    if (!isOwner && !isStaff) {
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
