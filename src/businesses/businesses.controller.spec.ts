import { Test } from '@nestjs/testing';
import { BusinessesController } from './businesses.controller';
import { BusinessesService } from './businesses.service';
import { ReviewsService } from '../reviews/reviews.service';

describe('BusinessesController (public read routes)', () => {
  let controller: BusinessesController;
  let businessesService: { findAll: jest.Mock; findFeatured: jest.Mock; findPromoted: jest.Mock; findOne: jest.Mock };

  beforeEach(async () => {
    businessesService = {
      findAll: jest.fn().mockResolvedValue({ data: [], meta: {} }),
      findFeatured: jest.fn().mockResolvedValue([]),
      findPromoted: jest.fn().mockResolvedValue([]),
      findOne: jest.fn().mockResolvedValue({ id: 1, slug: 'soy-milliy-taomlar' }),
    };

    const moduleRef = await Test.createTestingModule({
      controllers: [BusinessesController],
      providers: [
        { provide: BusinessesService, useValue: businessesService },
        { provide: ReviewsService, useValue: {} },
      ],
    }).compile();

    controller = moduleRef.get(BusinessesController);
  });

  it('GET /businesses delegates to findAll with the query', async () => {
    const query = { page: 1, limit: 20 } as any;
    await controller.findAll(query);
    expect(businessesService.findAll).toHaveBeenCalledWith(query);
  });

  it('GET /businesses/featured delegates to findFeatured', async () => {
    await controller.findFeatured();
    expect(businessesService.findFeatured).toHaveBeenCalledTimes(1);
  });

  it('GET /businesses/promoted delegates to findPromoted', async () => {
    await controller.findPromoted();
    expect(businessesService.findPromoted).toHaveBeenCalledTimes(1);
  });

  it('GET /businesses/:id accepts a slug and delegates to findOne', async () => {
    const result = await controller.findOne('soy-milliy-taomlar');
    expect(businessesService.findOne).toHaveBeenCalledWith('soy-milliy-taomlar');
    expect(result).toEqual({ id: 1, slug: 'soy-milliy-taomlar' });
  });
});
