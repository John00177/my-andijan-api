import { Test } from '@nestjs/testing';
import { SearchController } from './search.controller';
import { SearchService } from './search.service';

describe('SearchController', () => {
  it('delegates to SearchService.search with the parsed query', async () => {
    const searchService = { search: jest.fn().mockResolvedValue({ data: [], meta: {} }) };
    const moduleRef = await Test.createTestingModule({
      controllers: [SearchController],
      providers: [{ provide: SearchService, useValue: searchService }],
    }).compile();

    const controller = moduleRef.get(SearchController);
    const query = { q: 'osh', page: 1, limit: 20 } as any;

    const result = await controller.search(query);

    expect(searchService.search).toHaveBeenCalledWith(query);
    expect(result).toEqual({ data: [], meta: {} });
  });
});
