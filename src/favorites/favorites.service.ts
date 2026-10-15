import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { BusinessStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { changeBusinessFavoriteCount } from '../common/counters';
import { CreateFavoriteDto } from './dto/create-favorite.dto';

const FAVORITE_BUSINESS_SELECT = {
  id: true,
  slug: true,
  name: true,
  logoUrl: true,
  ratingAvg: true,
  reviewCount: true,
  category: { select: { id: true, slug: true, nameUz: true, nameRu: true, nameEn: true } },
  branches: {
    where: { deletedAt: null },
    orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }],
    take: 1,
    select: {
      id: true,
      address: true,
      phone: true,
      district: { select: { id: true, slug: true, nameUz: true } },
      city: { select: { id: true, slug: true, nameUz: true } },
    },
  },
} satisfies Prisma.BusinessSelect;

@Injectable()
export class FavoritesService {
  constructor(private readonly prisma: PrismaService) {}

  async create(userId: number, dto: CreateFavoriteDto) {
    const business = await this.prisma.business.findFirst({
      where: { id: dto.businessId, status: BusinessStatus.APPROVED, deletedAt: null },
    });
    if (!business) {
      throw new NotFoundException(`Business ${dto.businessId} not found`);
    }

    try {
      return await this.prisma.$transaction(async (tx) => {
        const favorite = await tx.favorite.create({
          data: { userId, businessId: dto.businessId },
        });
        // Plain SQL increment (Phase 16F.6): a favourite is not an edit of
        // the listing, so it must not move the business's updatedAt.
        await changeBusinessFavoriteCount(tx, dto.businessId, 1);
        return favorite;
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new ConflictException('Business is already in your favorites');
      }
      throw error;
    }
  }

  async remove(userId: number, businessId: number) {
    const favorite = await this.prisma.favorite.findUnique({
      where: { userId_businessId: { userId, businessId } },
    });
    if (!favorite) {
      throw new NotFoundException('Favorite not found');
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.favorite.delete({ where: { id: favorite.id } });
      await changeBusinessFavoriteCount(tx, businessId, -1);
    });

    return { success: true };
  }

  async findMine(userId: number) {
    const favorites = await this.prisma.favorite.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      include: { business: { select: FAVORITE_BUSINESS_SELECT } },
    });

    return favorites.map((f) => {
      const { branches, ...rest } = f.business;
      return {
        favoritedAt: f.createdAt,
        business: { ...rest, primaryBranch: branches[0] ?? null },
      };
    });
  }
}
