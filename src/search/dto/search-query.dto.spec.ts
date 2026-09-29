import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { SearchQueryDto } from './search-query.dto';

describe('SearchQueryDto', () => {
  it('rejects an empty query', async () => {
    const dto = plainToInstance(SearchQueryDto, { q: '' });
    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'q')).toBe(true);
  });

  it('defaults page and limit when omitted', () => {
    const dto = plainToInstance(SearchQueryDto, { q: 'osh' });
    expect(dto.page).toBe(1);
    expect(dto.limit).toBe(20);
  });

  it('rejects a limit above 100', async () => {
    const dto = plainToInstance(SearchQueryDto, { q: 'osh', limit: 500 });
    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'limit')).toBe(true);
  });
});
