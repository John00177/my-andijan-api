import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { UpdateProfileDto } from './dto/update-profile.dto';

const PROFILE_SELECT = {
  id: true,
  phone: true,
  fullName: true,
  role: true,
  email: true,
  age: true,
  gender: true,
  avatarId: true,
  districtId: true,
  createdAt: true,
} satisfies Prisma.UserSelect;

@Injectable()
export class UsersService {
  constructor(private readonly prisma: PrismaService) {}

  // Lets the frontend refresh its cached user object from the source of
  // truth on app mount, instead of only ever trusting whatever got written
  // to localStorage at login/last save.
  async getMe(userId: number) {
    return this.prisma.user.findUniqueOrThrow({ where: { id: userId }, select: PROFILE_SELECT });
  }

  async updateMe(userId: number, dto: UpdateProfileDto) {
    if (dto.districtId != null) {
      const district = await this.prisma.district.findUnique({ where: { id: dto.districtId } });
      if (!district) {
        throw new NotFoundException(`District ${dto.districtId} not found`);
      }
    }

    try {
      return await this.prisma.user.update({
        where: { id: userId },
        data: {
          email: dto.email,
          age: dto.age,
          gender: dto.gender,
          avatarId: dto.avatarId,
          districtId: dto.districtId,
        },
        select: PROFILE_SELECT,
      });
    } catch (error) {
      // Email carries a DB-level @unique constraint — surface the collision
      // as a clean 409 instead of letting Prisma's P2002 bubble up as a 500.
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new ConflictException('Email is already registered');
      }
      throw error;
    }
  }
}
