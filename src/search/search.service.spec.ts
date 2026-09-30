import { Test } from '@nestjs/testing';
import { SearchService } from './search.service';
import { PrismaService } from '../prisma/prisma.service';
import { SearchQueryDto } from './dto/search-query.dto';

describe('SearchService', () => {
  let service: SearchService;
  let prisma: {
    $queryRaw: jest.Mock;
    business: { findMany: jest.Mock };
    product: { findMany: jest.Mock };
  };

  beforeEach(async () => {
    prisma = {
      $queryRaw: jest.fn(),
      business: { findMany: jest.fn() },
      product: { findMany: jest.fn() },
    };

    const moduleRef = await Test.createTestingModule({
      providers: [SearchService, { provide: PrismaService, useValue: prisma }],
    }).compile();

    service = moduleRef.get(SearchService);
  });

  function query(overrides: Partial<SearchQueryDto> = {}): SearchQueryDto {
    return { q: 'osh', page: 1, limit: 20, ...overrides } as SearchQueryDto;
  }

  it('hydrates ranked hits into the response contract, preserving score order', async () => {
    prisma.$queryRaw
      .mockResolvedValueOnce([{ kind: 'BUSINESS', id: 1, score: 0.9 }])
      .mockResolvedValueOnce([{ count: 1, normalized: 'osh' }]);
    prisma.business.findMany.mockResolvedValue([
      { id: 1, slug: 'osh-markazi', name: 'Osh markazi', description: null, branches: [] },
    ]);

    const result = await service.search(query());

    expect(result.data).toEqual([
      expect.objectContaining({ type: 'business', score: 0.9, id: 1, slug: 'osh-markazi' }),
    ]);
    expect(result.meta).toEqual({
      page: 1,
      limit: 20,
      total: 1,
      totalPages: 1,
      query: 'osh',
      normalizedQuery: 'osh',
    });
  });

  it('reports an empty result set without querying for display data', async () => {
    prisma.$queryRaw.mockResolvedValueOnce([]).mockResolvedValueOnce([{ count: 0, normalized: 'zzz' }]);

    const result = await service.search(query({ q: 'zzz' }));

    expect(result.data).toEqual([]);
    expect(result.meta.total).toBe(0);
    expect(result.meta.totalPages).toBe(1);
    expect(prisma.business.findMany).not.toHaveBeenCalled();
    expect(prisma.product.findMany).not.toHaveBeenCalled();
  });

  it('computes pagination offset/limit from page and limit', async () => {
    prisma.$queryRaw.mockResolvedValueOnce([]).mockResolvedValueOnce([{ count: 0, normalized: '' }]);

    await service.search(query({ page: 3, limit: 10 }));

    const pagedCall = prisma.$queryRaw.mock.calls[0][0] as { values: unknown[] };
    // q, q (tsquery), then OFFSET, LIMIT are the last two bound values.
    expect(pagedCall.values.slice(-2)).toEqual([20, 10]);
  });

  describe('type filter', () => {
    it('restricts the hits CTE to business_hits only when type=business', () => {
      const cte = (service as any).buildHitsCte(query({ type: 'business' }));
      expect(cte.sql).toContain('FROM business_hits');
      expect(cte.sql).not.toContain('FROM product_hits');
    });

    it('restricts the hits CTE to product_hits only when type=product', () => {
      const cte = (service as any).buildHitsCte(query({ type: 'product' }));
      expect(cte.sql).toContain('FROM product_hits');
      expect(cte.sql).not.toContain('SELECT kind, id, score FROM business_hits');
    });

    it('unions both kinds when type is omitted (unchanged default behavior)', () => {
      const cte = (service as any).buildHitsCte(query());
      expect(cte.sql).toContain('FROM business_hits');
      expect(cte.sql).toContain('FROM product_hits');
    });
  });

  describe('visibility rules', () => {
    it('only ever queries approved, non-deleted businesses', () => {
      const cte = (service as any).buildHitsCte(query());
      expect(cte.sql).toContain("b.status = 'APPROVED'::\"BusinessStatus\"");
      expect(cte.sql).toContain('b.deleted_at IS NULL');
    });

    it('only ever queries active, non-deleted products from approved businesses', () => {
      const cte = (service as any).buildHitsCte(query());
      expect(cte.sql).toContain('p.is_active = true');
      expect(cte.sql).toContain('p.deleted_at IS NULL');
    });
  });

  describe('filters', () => {
    it('applies the category filter to the business CTE', () => {
      const cte = (service as any).buildHitsCte(query({ category: 'oziq-ovqat' }));
      expect(cte.sql).toContain('AND bc.slug = ?');
    });

    it('applies the district filter as an EXISTS clause against branches', () => {
      const cte = (service as any).buildHitsCte(query({ district: 4 }));
      expect(cte.sql).toContain('br.district_id = ?');
    });
  });
});
