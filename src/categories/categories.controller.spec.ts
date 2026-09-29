import { Test } from '@nestjs/testing';
import { CategoriesController } from './categories.controller';
import { CategoriesService } from './categories.service';

describe('CategoriesController', () => {
  let controller: CategoriesController;
  let categoriesService: { findHomepage: jest.Mock; findTree: jest.Mock; findBySlug: jest.Mock };

  beforeEach(async () => {
    categoriesService = {
      findHomepage: jest.fn().mockResolvedValue([{ id: 1 }]),
      findTree: jest.fn().mockResolvedValue([{ id: 1, children: [] }]),
      findBySlug: jest.fn().mockResolvedValue({ id: 1, slug: 'food' }),
    };

    const moduleRef = await Test.createTestingModule({
      controllers: [CategoriesController],
      providers: [{ provide: CategoriesService, useValue: categoriesService }],
    }).compile();

    controller = moduleRef.get(CategoriesController);
  });

  it('GET /categories/homepage delegates to findHomepage', async () => {
    await controller.findHomepage();
    expect(categoriesService.findHomepage).toHaveBeenCalledTimes(1);
  });

  it('GET /categories delegates to findTree', async () => {
    await controller.findTree();
    expect(categoriesService.findTree).toHaveBeenCalledTimes(1);
  });

  it('GET /categories/:slug delegates to findBySlug with the slug', async () => {
    await controller.findBySlug('food');
    expect(categoriesService.findBySlug).toHaveBeenCalledWith('food');
  });
});
