import { NotFoundException } from '@nestjs/common';
import { BusinessStatus, Prisma } from '@prisma/client';
import { runWithRequestContext } from '../common/request-context/request-context';
import { PrismaService } from '../prisma/prisma.service';
import { AnalyticsGate } from './analytics-gate';
import { AnalyticsService, MAX_SEARCH_QUERIES_PER_DAY, MAX_VISITOR_CITIES_PER_DAY } from './analytics.service';
import { AnalyticsClickAction } from './dto/record-click.dto';

// Phase 16G: the anonymous collectors validate, then ask AnalyticsGate, then
// write — and never grow a day's arrays without bound.

const sqlText = (statement: Prisma.Sql) => statement.text.replace(/\s+/g, ' ').trim();
const fromBrowser = <T>(fn: () => T) =>
  runWithRequestContext({ requestId: 'r', ipAddress: '203.0.113.7', userAgent: 'Mozilla/5.0 Mobile' }, fn);

function setup() {
  const tx = {
    businessAnalytics: { upsert: jest.fn().mockResolvedValue({}) },
    activityLog: { create: jest.fn().mockResolvedValue({}) },
    searchAnalytics: { create: jest.fn().mockResolvedValue({}) },
    $executeRaw: jest.fn().mockResolvedValue(1),
  };
  const prisma = {
    business: { findFirst: jest.fn().mockResolvedValue({ id: 5, status: BusinessStatus.APPROVED }) },
    city: { findUnique: jest.fn().mockResolvedValue({ id: 3 }) },
    $transaction: jest.fn((arg: unknown) =>
      typeof arg === 'function' ? (arg as (t: typeof tx) => unknown)(tx) : Promise.all(arg as unknown[]),
    ),
    businessAnalytics: tx.businessAnalytics,
    activityLog: tx.activityLog,
  };
  const service = new AnalyticsService(prisma as unknown as PrismaService, new AnalyticsGate());
  /** The i-th Prisma.Sql passed to $executeRaw. */
  const executed = (i: number) => tx.$executeRaw.mock.calls[i][0] as Prisma.Sql;
  /** The SQL text of every $executeRaw statement, in order. */
  const statements = () => tx.$executeRaw.mock.calls.map((_, i) => sqlText(executed(i)));
  return { tx, prisma, service, statements, executed };
}

describe('AnalyticsService collectors (Phase 16G)', () => {
  describe('POST /analytics/view', () => {
    it('records a view once per client: a refresh answers success and writes nothing', async () => {
      const { tx, prisma, service } = setup();

      await expect(fromBrowser(() => service.recordView({ businessId: 5 }))).resolves.toEqual({ success: true });
      await expect(fromBrowser(() => service.recordView({ businessId: 5 }))).resolves.toEqual({ success: true });

      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      expect(tx.businessAnalytics.upsert).toHaveBeenCalledTimes(1);
      expect(tx.activityLog.create).toHaveBeenCalledTimes(1);
    });

    it('still answers 404 for an unknown business, every time (validation runs before the gate)', async () => {
      const { prisma, service } = setup();
      prisma.business.findFirst.mockResolvedValue(null);

      await expect(fromBrowser(() => service.recordView({ businessId: 404 }))).rejects.toThrow(NotFoundException);
      await expect(fromBrowser(() => service.recordView({ businessId: 404 }))).rejects.toThrow(NotFoundException);
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('appends the visitor city only while the day holds fewer than the cap — the counter itself is not capped', async () => {
      const { tx, service, statements, executed } = setup();

      await fromBrowser(() => service.recordView({ businessId: 5, cityId: 3 }));

      const { update, create } = tx.businessAnalytics.upsert.mock.calls[0][0];
      expect(update).toEqual({ pageViews: { increment: 1 } }); // no unbounded push
      expect(create).toEqual(expect.objectContaining({ pageViews: 1, visitorCities: [] }));
      const index = statements().findIndex((s) => s.includes('visitor_cities'));
      expect(statements()[index]).toBe(
        'UPDATE business_analytics SET visitor_cities = array_append(visitor_cities, $1::int) ' +
          'WHERE business_id = $2 AND date = $3::date AND cardinality(visitor_cities) < $4',
      );
      expect(executed(index).values).toEqual([
        3,
        5,
        expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
        MAX_VISITOR_CITIES_PER_DAY,
      ]);
    });

    it('appends nothing when no city is given', async () => {
      const { service, statements } = setup();
      await fromBrowser(() => service.recordView({ businessId: 5 }));
      expect(statements().some((s) => s.includes('visitor_cities'))).toBe(false);
    });
  });

  describe('POST /analytics/click', () => {
    it('counts a double tap once, and different actions separately', async () => {
      const { tx, service } = setup();
      const click = (action: AnalyticsClickAction) => fromBrowser(() => service.recordClick({ businessId: 5, action }));

      await click(AnalyticsClickAction.CALL);
      await click(AnalyticsClickAction.CALL);
      await click(AnalyticsClickAction.DIRECTION);

      expect(tx.businessAnalytics.upsert).toHaveBeenCalledTimes(2);
      expect(tx.activityLog.create.mock.calls.map(([arg]) => arg.data.actionType)).toEqual([
        'CALL_CLICKED',
        'DIRECTION_CLICKED',
      ]);
    });
  });

  describe('POST /analytics/search', () => {
    const search = { query: 'Osh markaz', resultCount: 4 };

    it('logs an unattributed search, ignores a repeat (case/space-insensitive), and touches no business row', async () => {
      const { tx, service, statements } = setup();

      await fromBrowser(() => service.recordSearch(search));
      await fromBrowser(() => service.recordSearch({ ...search, query: '  osh MARKAZ ' }));

      expect(tx.searchAnalytics.create).toHaveBeenCalledTimes(1);
      expect(tx.activityLog.create).toHaveBeenCalledTimes(1);
      expect(tx.businessAnalytics.upsert).not.toHaveBeenCalled();
      expect(statements()).toEqual([]);
    });

    it('treats the same query with different filters as a different search', async () => {
      const { tx, service } = setup();
      await fromBrowser(() => service.recordSearch(search));
      await fromBrowser(() => service.recordSearch({ ...search, districtId: 2 }));
      expect(tx.searchAnalytics.create).toHaveBeenCalledTimes(2);
    });

    it("folds an attributed search into the business's top terms, capped per day, in the same transaction", async () => {
      const { tx, prisma, service, statements, executed } = setup();

      await fromBrowser(() => service.recordSearch({ ...search, businessId: 5 }));

      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      const { update, create } = tx.businessAnalytics.upsert.mock.calls[0][0];
      expect(update).toEqual({});
      expect(create).toEqual(expect.objectContaining({ businessId: 5, searchQueries: [] }));
      expect(statements()).toEqual([
        'UPDATE business_analytics SET search_queries = array_append(search_queries, $1) ' +
          'WHERE business_id = $2 AND date = $3::date AND cardinality(search_queries) < $4',
      ]);
      expect(executed(0).values).toEqual([
        'Osh markaz',
        5,
        expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
        MAX_SEARCH_QUERIES_PER_DAY,
      ]);
    });
  });
});
