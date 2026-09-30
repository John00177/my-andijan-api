import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { SearchQueryDto } from './dto/search-query.dto';

interface Hit {
  kind: 'BUSINESS' | 'PRODUCT';
  id: number;
  score: number;
}

@Injectable()
export class SearchService {
  constructor(private readonly prisma: PrismaService) {}

  async search(query: SearchQueryDto) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;

    const hits = this.buildHitsCte(query);

    const [rows, [totals]] = await Promise.all([
      this.prisma.$queryRaw<Hit[]>(Prisma.sql`
        ${hits}
        SELECT kind, id, score FROM hits
        ORDER BY score DESC, kind ASC, id ASC
        OFFSET ${(page - 1) * limit} LIMIT ${limit}
      `),
      this.prisma.$queryRaw<{ count: number; normalized: string }[]>(Prisma.sql`
        ${hits}
        SELECT count(*)::int AS count, (SELECT nq FROM q) AS normalized FROM hits
      `),
    ]);

    const data = await this.hydrate(rows);
    const total = totals?.count ?? 0;

    return {
      data,
      meta: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit) || 1,
        query: query.q,
        // Exposed for debuggability: shows what the query folded down to
        // after transliteration, which is otherwise invisible to callers.
        normalizedQuery: totals?.normalized ?? '',
      },
    };
  }

  // Both the page query and the count query run over the same candidate set,
  // so the CTE is built once and spliced into each.
  private buildHitsCte(query: SearchQueryDto): Prisma.Sql {
    const { q, category, type } = query;

    // Both CTEs are always defined below (cheap, and keeps this method
    // simple); only the kind(s) requested are referenced in `hits`, so
    // Postgres never executes an unreferenced CTE.
    const includeBusiness = type !== 'product';
    const includeProduct = type !== 'business';

    const businessCategory = category ? Prisma.sql`AND bc.slug = ${category}` : Prisma.empty;
    // A product matches the category filter through its own category or,
    // when it has none, through the category of the business selling it.
    const productCategory = category
      ? Prisma.sql`AND (pc.slug = ${category} OR bc.slug = ${category})`
      : Prisma.empty;

    const businessGeo = this.geoClause('b.id', query);
    const productGeo = this.geoClause('p.business_id', query);

    return Prisma.sql`
      WITH q AS (
        SELECT public.search_normalize(${q}) AS nq,
               public.search_tsquery(${q})   AS tsq
      ),
      business_hits AS (
        SELECT
          'BUSINESS'::text AS kind,
          b.id             AS id,
          GREATEST(
            CASE
              WHEN public.business_search_doc(b.name, b.description) @@ q.tsq
              THEN (0.6 + ts_rank(public.business_search_doc(b.name, b.description), q.tsq))::float8
              ELSE 0::float8
            END,
            word_similarity(q.nq, public.search_normalize(b.name))::float8
          ) AS score
        FROM businesses b
        JOIN categories bc ON bc.id = b.category_id
        CROSS JOIN q
        WHERE b.status = 'APPROVED'::"BusinessStatus"
          AND b.deleted_at IS NULL
          AND (
            public.business_search_doc(b.name, b.description) @@ q.tsq
            OR q.nq <% public.search_normalize(b.name)
          )
          ${businessCategory}
          ${businessGeo}
      ),
      product_hits AS (
        SELECT
          'PRODUCT'::text AS kind,
          p.id            AS id,
          GREATEST(
            CASE
              WHEN public.product_search_doc(p.name) @@ q.tsq
              THEN (0.6 + ts_rank(public.product_search_doc(p.name), q.tsq))::float8
              ELSE 0::float8
            END,
            word_similarity(q.nq, public.search_normalize(p.name))::float8
          ) AS score
        FROM products p
        JOIN businesses b ON b.id = p.business_id
        JOIN categories bc ON bc.id = b.category_id
        LEFT JOIN categories pc ON pc.id = p.category_id
        CROSS JOIN q
        WHERE p.is_active = true
          AND p.deleted_at IS NULL
          AND b.status = 'APPROVED'::"BusinessStatus"
          AND b.deleted_at IS NULL
          AND (
            public.product_search_doc(p.name) @@ q.tsq
            OR q.nq <% public.search_normalize(p.name)
          )
          ${productCategory}
          ${productGeo}
      ),
      hits AS (
        ${Prisma.join(
          [
            ...(includeBusiness ? [Prisma.sql`SELECT kind, id, score FROM business_hits`] : []),
            ...(includeProduct ? [Prisma.sql`SELECT kind, id, score FROM product_hits`] : []),
          ],
          ' UNION ALL ',
        )}
      )
    `;
  }

  // Geography lives on Branch, so both sides filter through the owning
  // business's branches. `businessIdColumn` is an internal constant, never
  // caller input.
  private geoClause(businessIdColumn: string, query: SearchQueryDto): Prisma.Sql {
    const conditions: Prisma.Sql[] = [];
    if (query.district) conditions.push(Prisma.sql`br.district_id = ${query.district}`);
    if (query.city) conditions.push(Prisma.sql`br.city_id = ${query.city}`);
    if (conditions.length === 0) return Prisma.empty;

    return Prisma.sql`AND EXISTS (
      SELECT 1 FROM branches br
      WHERE br.business_id = ${Prisma.raw(businessIdColumn)}
        AND br.deleted_at IS NULL
        AND ${Prisma.join(conditions, ' AND ')}
    )`;
  }

  // The ranked page is only ids + scores; fetch the display payloads through
  // Prisma and re-apply the ranking order.
  private async hydrate(rows: Hit[]) {
    const businessIds = rows.filter((r) => r.kind === 'BUSINESS').map((r) => r.id);
    const productIds = rows.filter((r) => r.kind === 'PRODUCT').map((r) => r.id);

    const [businesses, products] = await Promise.all([
      businessIds.length
        ? this.prisma.business.findMany({
            where: { id: { in: businessIds } },
            select: {
              id: true,
              slug: true,
              name: true,
              description: true,
              logoUrl: true,
              ratingAvg: true,
              reviewCount: true,
              category: { select: { slug: true, nameUz: true, nameRu: true, nameEn: true } },
              branches: {
                where: { deletedAt: null },
                orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }],
                take: 1,
                select: {
                  id: true,
                  address: true,
                  phone: true,
                  district: { select: { id: true, slug: true, nameUz: true } },
                  city: { select: { id: true, slug: true, nameUz: true } },
                },
              },
            },
          })
        : [],
      productIds.length
        ? this.prisma.product.findMany({
            where: { id: { in: productIds } },
            select: {
              id: true,
              slug: true,
              name: true,
              description: true,
              imageUrl: true,
              price: true,
              currency: true,
              unit: true,
              type: true,
              business: { select: { slug: true, name: true } },
            },
          })
        : [],
    ]);

    const businessById = new Map(businesses.map((b) => [b.id, b]));
    const productById = new Map(products.map((p) => [p.id, p]));

    return rows
      .map((row) => {
        if (row.kind === 'BUSINESS') {
          const business = businessById.get(row.id);
          if (!business) return null;
          const { branches, ...rest } = business;
          return { type: 'business' as const, score: row.score, ...rest, primaryBranch: branches[0] ?? null };
        }

        const product = productById.get(row.id);
        if (!product) return null;
        // Product.type is the PRODUCT/SERVICE enum — renamed so it cannot
        // collide with the result discriminator.
        const { type: productType, ...rest } = product;
        return { type: 'product' as const, score: row.score, productType, ...rest };
      })
      .filter((item): item is NonNullable<typeof item> => item !== null);
  }
}
