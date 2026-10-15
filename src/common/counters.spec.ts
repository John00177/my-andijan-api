import { ConflictException, NotFoundException } from '@nestjs/common';
import { AttendeeStatus, BusinessStatus, EventStatus, Prisma } from '@prisma/client';
import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { AnalyticsService } from '../analytics/analytics.service';
import { BusinessesService } from '../businesses/businesses.service';
import { EventsService } from '../events/events.service';
import { FavoritesService } from '../favorites/favorites.service';
import { OwnerService } from '../owner/owner.service';
import { PrismaService } from '../prisma/prisma.service';
import { changeBusinessFavoriteCount, incrementBusinessViewCount, incrementEventAttendeeCount } from './counters';

// Phase 16F.6: engagement counters (views, favourites, RSVPs) must not move a
// row's updatedAt — the sitemap uses it as "content last modified".
//
// How updatedAt could change, and what each test pins:
//   1. Prisma Client's @updatedAt, set on every model update()/updateMany() —
//      so no counter may go through business.update / event.update. The mock
//      transaction clients below deliberately have NO business/event update:
//      a regression to the Prisma path throws.
//   2. The SQL itself — so each counter statement is asserted verbatim: one
//      `col = col ± 1`, never `updated_at`.
//   3. A database trigger — none exists; the migration guard below fails if
//      one is ever added.

// `.text` is the PostgreSQL form ($1 placeholders) — what is actually sent.
const sqlText = (statement: Prisma.Sql) => statement.text.replace(/\s+/g, ' ').trim();

/** The single Prisma.Sql passed to $executeRaw. */
function executed(executeRaw: jest.Mock, call = 0): Prisma.Sql {
  return executeRaw.mock.calls[call][0] as Prisma.Sql;
}

describe('engagement counters (Phase 16F.6)', () => {
  describe('the SQL each counter sends', () => {
    it.each([
      [
        'view',
        (db: { $executeRaw: jest.Mock }) => incrementBusinessViewCount(db as never, 5),
        'UPDATE "businesses" SET "view_count" = "view_count" + 1 WHERE "id" = $1',
        [5],
      ],
      [
        'favourite +1',
        (db: { $executeRaw: jest.Mock }) => changeBusinessFavoriteCount(db as never, 5, 1),
        'UPDATE "businesses" SET "favorite_count" = "favorite_count" + 1 WHERE "id" = $1',
        [5],
      ],
      [
        'favourite -1',
        (db: { $executeRaw: jest.Mock }) => changeBusinessFavoriteCount(db as never, 5, -1),
        'UPDATE "businesses" SET "favorite_count" = "favorite_count" - 1 WHERE "id" = $1',
        [5],
      ],
      [
        'RSVP',
        (db: { $executeRaw: jest.Mock }) => incrementEventAttendeeCount(db as never, 9),
        'UPDATE "events" SET "attendee_count" = "attendee_count" + 1 WHERE "id" = $1',
        [9],
      ],
    ])('%s: one atomic in-place increment, id bound as a parameter, updated_at untouched', async (_name, run, sql, values) => {
      const db = { $executeRaw: jest.fn().mockResolvedValue(1) };

      await run(db);

      expect(db.$executeRaw).toHaveBeenCalledTimes(1);
      expect(sqlText(executed(db.$executeRaw))).toBe(sql);
      expect(executed(db.$executeRaw).values).toEqual(values);
      expect(executed(db.$executeRaw).text).not.toMatch(/updated_at/i);
    });

    it('throws (so the surrounding transaction rolls back) unless exactly one row changed', async () => {
      const db = { $executeRaw: jest.fn().mockResolvedValue(0) };

      await expect(incrementBusinessViewCount(db as never, 404)).rejects.toThrow(NotFoundException);
      await expect(incrementEventAttendeeCount(db as never, 404)).rejects.toThrow(NotFoundException);
    });
  });

  it('no migration defines a trigger (the only way plain SQL could still change updated_at)', () => {
    const dir = join(__dirname, '..', '..', 'prisma', 'migrations');
    const offending = readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .filter((entry) => /CREATE\s+(OR\s+REPLACE\s+)?(CONSTRAINT\s+)?TRIGGER/i.test(readFileSync(join(dir, entry.name, 'migration.sql'), 'utf8')))
      .map((entry) => entry.name);

    expect(offending).toEqual([]);
  });

  describe('callers use the counters, never Prisma update', () => {
    it('POST /analytics/view: records the view with the plain-SQL increment, in one transaction', async () => {
      const tx = {
        businessAnalytics: { upsert: jest.fn().mockResolvedValue({}) },
        activityLog: { create: jest.fn().mockResolvedValue({}) },
        $executeRaw: jest.fn().mockResolvedValue(1),
      };
      const prisma = {
        business: { findFirst: jest.fn().mockResolvedValue({ id: 5, status: BusinessStatus.APPROVED }) },
        $transaction: jest.fn((fn: (t: typeof tx) => unknown) => fn(tx)),
      };

      await expect(new AnalyticsService(prisma as unknown as PrismaService).recordView({ businessId: 5 } as never)).resolves.toEqual({
        success: true,
      });

      expect(tx.businessAnalytics.upsert).toHaveBeenCalledTimes(1);
      expect(sqlText(executed(tx.$executeRaw))).toContain('"view_count" = "view_count" + 1');
      expect(tx.activityLog.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ actionType: 'BUSINESS_VIEWED', businessId: 5 }) }),
      );
    });

    it('POST /analytics/view: a counter that matches no row fails the whole transaction', async () => {
      const tx = {
        businessAnalytics: { upsert: jest.fn().mockResolvedValue({}) },
        activityLog: { create: jest.fn() },
        $executeRaw: jest.fn().mockResolvedValue(0),
      };
      const prisma = {
        business: { findFirst: jest.fn().mockResolvedValue({ id: 5 }) },
        $transaction: jest.fn((fn: (t: typeof tx) => unknown) => fn(tx)),
      };

      await expect(new AnalyticsService(prisma as unknown as PrismaService).recordView({ businessId: 5 } as never)).rejects.toThrow(
        NotFoundException,
      );
      expect(tx.activityLog.create).not.toHaveBeenCalled();
    });

    describe('favourites', () => {
      function setup(executeRawResult = 1) {
        const tx = {
          favorite: { create: jest.fn().mockResolvedValue({ id: 3, userId: 7, businessId: 5 }), delete: jest.fn().mockResolvedValue({}) },
          $executeRaw: jest.fn().mockResolvedValue(executeRawResult),
        };
        const prisma = {
          business: { findFirst: jest.fn().mockResolvedValue({ id: 5, status: BusinessStatus.APPROVED }) },
          favorite: { findUnique: jest.fn().mockResolvedValue({ id: 3 }) },
          $transaction: jest.fn((fn: (t: typeof tx) => unknown) => fn(tx)),
        };
        return { tx, service: new FavoritesService(prisma as unknown as PrismaService) };
      }

      it('POST /favorites: creates the favourite and adds 1 with the plain-SQL counter', async () => {
        const { tx, service } = setup();

        await expect(service.create(7, { businessId: 5 } as never)).resolves.toEqual({ id: 3, userId: 7, businessId: 5 });
        expect(sqlText(executed(tx.$executeRaw))).toContain('"favorite_count" = "favorite_count" + 1');
        expect(executed(tx.$executeRaw).values).toEqual([5]);
      });

      it('POST /favorites: a duplicate is still a 409 and never touches the counter', async () => {
        const { tx, service } = setup();
        tx.favorite.create.mockRejectedValue(
          new Prisma.PrismaClientKnownRequestError('Unique constraint failed', { code: 'P2002', clientVersion: 'test' }),
        );

        await expect(service.create(7, { businessId: 5 } as never)).rejects.toThrow(ConflictException);
        expect(tx.$executeRaw).not.toHaveBeenCalled();
      });

      it('DELETE /favorites/:businessId: deletes the favourite and subtracts 1 in the same transaction', async () => {
        const { tx, service } = setup();

        await expect(service.remove(7, 5)).resolves.toEqual({ success: true });
        expect(tx.favorite.delete).toHaveBeenCalledWith({ where: { id: 3 } });
        expect(sqlText(executed(tx.$executeRaw))).toContain('"favorite_count" = "favorite_count" - 1');
      });
    });

    describe('POST /events/:slug/attend', () => {
      const event = {
        id: 9,
        slug: 'navroz',
        status: EventStatus.PUBLISHED,
        allowRsvp: true,
        maxAttendees: null,
        deletedAt: null,
      };

      function setup(existing: unknown = null) {
        const tx = {
          eventAttendee: {
            create: jest.fn().mockResolvedValue({ id: 1, status: AttendeeStatus.GOING }),
            update: jest.fn().mockResolvedValue({ id: 2, status: AttendeeStatus.GOING }),
          },
          $executeRaw: jest.fn().mockResolvedValue(1),
        };
        const prisma = {
          event: { findFirst: jest.fn().mockResolvedValue(event) },
          eventAttendee: { findUnique: jest.fn().mockResolvedValue(existing), count: jest.fn() },
          $transaction: jest.fn((fn: (t: typeof tx) => unknown) => fn(tx)),
        };
        return { tx, prisma, service: new EventsService(prisma as unknown as PrismaService) };
      }

      it('a new RSVP adds 1 with the plain-SQL counter', async () => {
        const { tx, service } = setup();

        await expect(service.attend('navroz', 7)).resolves.toEqual({ id: 1, status: AttendeeStatus.GOING });
        expect(sqlText(executed(tx.$executeRaw))).toContain('"attendee_count" = "attendee_count" + 1');
        expect(executed(tx.$executeRaw).values).toEqual([9]);
      });

      it('re-activating a cancelled RSVP also adds 1', async () => {
        const { tx, service } = setup({ id: 2, status: AttendeeStatus.CANCELLED });

        await expect(service.attend('navroz', 7)).resolves.toEqual({ id: 2, status: AttendeeStatus.GOING });
        expect(tx.$executeRaw).toHaveBeenCalledTimes(1);
      });

      it('an already-active RSVP stays idempotent: no write, no count', async () => {
        const active = { id: 2, status: AttendeeStatus.GOING };
        const { tx, prisma, service } = setup(active);

        await expect(service.attend('navroz', 7)).resolves.toBe(active);
        expect(prisma.$transaction).not.toHaveBeenCalled();
        expect(tx.$executeRaw).not.toHaveBeenCalled();
      });
    });
  });
});

describe('list responses expose updatedAt (Phase 16F.6)', () => {
  const updatedAt = new Date('2026-09-20T10:00:00.000Z');

  it('GET /businesses (and /featured, /promoted) select updatedAt and return it on each item', async () => {
    const row = { id: 1, slug: 'soy', name: 'Soy', updatedAt, branches: [] };
    const prisma = {
      business: { findMany: jest.fn().mockResolvedValue([row]), count: jest.fn().mockResolvedValue(1) },
      $transaction: jest.fn((ops: Promise<unknown>[]) => Promise.all(ops)),
    };
    const service = new BusinessesService(prisma as unknown as PrismaService, {} as OwnerService);

    const list = await service.findAll({} as never);
    expect(prisma.business.findMany.mock.calls[0][0].select.updatedAt).toBe(true);
    expect(list.data[0]).toMatchObject({ slug: 'soy', updatedAt, primaryBranch: null });
    expect(list.meta).toEqual({ page: 1, limit: 20, total: 1, totalPages: 1 });

    await service.findFeatured();
    await service.findPromoted();
    expect(prisma.business.findMany.mock.calls[1][0].select.updatedAt).toBe(true);
    expect(prisma.business.findMany.mock.calls[2][0].select.updatedAt).toBe(true);
  });

  it('GET /events selects updatedAt and returns it on each item, paging and filters unchanged', async () => {
    const row = { id: 9, slug: 'navroz', title: 'Navroz', updatedAt };
    const prisma = {
      event: { findMany: jest.fn().mockResolvedValue([row]), count: jest.fn().mockResolvedValue(1) },
      $transaction: jest.fn((ops: Promise<unknown>[]) => Promise.all(ops)),
    };
    const service = new EventsService(prisma as unknown as PrismaService);

    const list = await service.findAll({ page: 1, limit: 100, district: 3 } as never);
    const query = prisma.event.findMany.mock.calls[0][0];
    expect(query.select.updatedAt).toBe(true);
    expect(query.where).toEqual({ status: EventStatus.PUBLISHED, deletedAt: null, districtId: 3 });
    expect(list.data[0]).toEqual(row);
    expect(list.meta).toEqual({ page: 1, limit: 100, total: 1, totalPages: 1 });
  });
});
