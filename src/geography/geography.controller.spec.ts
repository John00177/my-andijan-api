import { Test } from '@nestjs/testing';
import { GeographyController } from './geography.controller';
import { GeographyService } from './geography.service';

describe('GeographyController', () => {
  let controller: GeographyController;
  let geographyService: {
    findAllRegions: jest.Mock;
    findAllDistricts: jest.Mock;
    findCitiesByDistrict: jest.Mock;
    findAllCities: jest.Mock;
    findCityById: jest.Mock;
  };

  beforeEach(async () => {
    geographyService = {
      findAllRegions: jest.fn().mockResolvedValue([{ id: 1 }]),
      findAllDistricts: jest.fn().mockResolvedValue([{ id: 1 }]),
      findCitiesByDistrict: jest.fn().mockResolvedValue([{ id: 1 }]),
      findAllCities: jest.fn().mockResolvedValue([{ id: 1 }]),
      findCityById: jest.fn().mockResolvedValue({ id: 1 }),
    };

    const moduleRef = await Test.createTestingModule({
      controllers: [GeographyController],
      providers: [{ provide: GeographyService, useValue: geographyService }],
    }).compile();

    controller = moduleRef.get(GeographyController);
  });

  it('GET /geography/regions delegates to findAllRegions', async () => {
    await controller.findAllRegions();
    expect(geographyService.findAllRegions).toHaveBeenCalledTimes(1);
  });

  it('GET /geography/districts delegates to findAllDistricts', async () => {
    await controller.findAllDistricts();
    expect(geographyService.findAllDistricts).toHaveBeenCalledTimes(1);
  });

  it('GET /geography/districts/:id/cities delegates with the numeric id', async () => {
    await controller.findCitiesByDistrict(3);
    expect(geographyService.findCitiesByDistrict).toHaveBeenCalledWith(3);
  });

  it('GET /geography/cities/:id delegates with the numeric id', async () => {
    await controller.findCityById(7);
    expect(geographyService.findCityById).toHaveBeenCalledWith(7);
  });
});
