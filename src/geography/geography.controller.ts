import { Controller, Get, Param, ParseIntPipe } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { GeographyService } from './geography.service';

@ApiTags('geography')
@Controller('geography')
export class GeographyController {
  constructor(private readonly geographyService: GeographyService) {}

  @Get('regions')
  findAllRegions() {
    return this.geographyService.findAllRegions();
  }

  @Get('districts')
  findAllDistricts() {
    return this.geographyService.findAllDistricts();
  }

  @Get('districts/:id/cities')
  findCitiesByDistrict(@Param('id', ParseIntPipe) id: number) {
    return this.geographyService.findCitiesByDistrict(id);
  }

  @Get('cities')
  findAllCities() {
    return this.geographyService.findAllCities();
  }

  @Get('cities/:id')
  findCityById(@Param('id', ParseIntPipe) id: number) {
    return this.geographyService.findCityById(id);
  }
}
