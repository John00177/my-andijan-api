import { Controller, Get, Param, ParseIntPipe } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { GeographyService } from './geography.service';
import { Public } from '../authz/authz.decorators';

@ApiTags('geography')
@Controller('geography')
export class GeographyController {
  constructor(private readonly geographyService: GeographyService) {}

  @Public()
  @Get('regions')
  findAllRegions() {
    return this.geographyService.findAllRegions();
  }

  @Public()
  @Get('districts')
  findAllDistricts() {
    return this.geographyService.findAllDistricts();
  }

  @Public()
  @Get('districts/:id/cities')
  findCitiesByDistrict(@Param('id', ParseIntPipe) id: number) {
    return this.geographyService.findCitiesByDistrict(id);
  }

  @Public()
  @Get('cities')
  findAllCities() {
    return this.geographyService.findAllCities();
  }

  @Public()
  @Get('cities/:id')
  findCityById(@Param('id', ParseIntPipe) id: number) {
    return this.geographyService.findCityById(id);
  }
}
