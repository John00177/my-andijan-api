import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class GeographyService {
  constructor(private readonly prisma: PrismaService) {}

  findAllRegions() {
    return this.prisma.region.findMany({
      orderBy: { sortOrder: 'asc' },
      include: {
        districts: {
          orderBy: { sortOrder: 'asc' },
          include: {
            cities: { orderBy: { sortOrder: 'asc' } },
          },
        },
        // Region-level cities (e.g. Andijon) sit directly under the region,
        // not inside any district.
        cities: {
          where: { isRegionLevel: true },
          orderBy: { sortOrder: 'asc' },
        },
      },
    });
  }

  findAllDistricts() {
    return this.prisma.district.findMany({
      orderBy: { sortOrder: 'asc' },
      include: { region: true },
    });
  }

  async findCitiesByDistrict(districtId: number) {
    const district = await this.prisma.district.findUnique({ where: { id: districtId } });
    if (!district) {
      throw new NotFoundException(`District ${districtId} not found`);
    }

    return this.prisma.city.findMany({
      where: { districtId },
      orderBy: { sortOrder: 'asc' },
    });
  }

  findAllCities() {
    return this.prisma.city.findMany({
      orderBy: { sortOrder: 'asc' },
      include: { district: true, region: true },
    });
  }

  async findCityById(id: number) {
    const city = await this.prisma.city.findUnique({
      where: { id },
      include: {
        district: true,
        region: true,
        _count: { select: { branches: true } },
      },
    });

    if (!city) {
      throw new NotFoundException(`City ${id} not found`);
    }

    return city;
  }
}
