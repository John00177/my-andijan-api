import { NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

// Engagement counters that must NOT move a row's `updatedAt` (Phase 16F.6).
//
// `updatedAt` is Prisma's `@updatedAt`: Prisma Client sets it on EVERY
// update/updateMany, counter increments included — there is no database
// trigger (see the migration guard in counters.spec.ts). So
// `business.update({ viewCount: { increment: 1 } })` stamped a business as
// "modified" every time someone merely opened its page, which made
// `updatedAt` useless as a content last-modified date (e.g. sitemap lastmod).
//
// Each counter below is ONE plain SQL UPDATE: `col = col ± 1` on a single row
// is the same atomic, row-locked increment Prisma issued (concurrent views or
// RSVPs still all count), it just leaves `updated_at` alone. Table/column
// names are fixed literals; only the id is a bound parameter.
//
// Pass the transaction client when the counter must commit or roll back with
// other writes. Exactly one row must change: Prisma's update threw P2025 on a
// missing row (rolling the transaction back), and this keeps that guarantee.

type CounterDb = Pick<Prisma.TransactionClient, '$executeRaw'>;

async function exactlyOne(db: CounterDb, statement: Prisma.Sql, what: string): Promise<void> {
  const changed = await db.$executeRaw(statement);
  if (changed !== 1) throw new NotFoundException(`${what} not found`);
}

/** +1 page view (POST /analytics/view). */
export function incrementBusinessViewCount(db: CounterDb, businessId: number): Promise<void> {
  return exactlyOne(
    db,
    Prisma.sql`UPDATE "businesses" SET "view_count" = "view_count" + 1 WHERE "id" = ${businessId}`,
    `Business ${businessId}`,
  );
}

/** ±1 favourite (POST /favorites, DELETE /favorites/:businessId). Unclamped, exactly as before. */
export function changeBusinessFavoriteCount(db: CounterDb, businessId: number, delta: 1 | -1): Promise<void> {
  const statement =
    delta === 1
      ? Prisma.sql`UPDATE "businesses" SET "favorite_count" = "favorite_count" + 1 WHERE "id" = ${businessId}`
      : Prisma.sql`UPDATE "businesses" SET "favorite_count" = "favorite_count" - 1 WHERE "id" = ${businessId}`;
  return exactlyOne(db, statement, `Business ${businessId}`);
}

/** +1 active RSVP (POST /events/:slug/attend). */
export function incrementEventAttendeeCount(db: CounterDb, eventId: number): Promise<void> {
  return exactlyOne(
    db,
    Prisma.sql`UPDATE "events" SET "attendee_count" = "attendee_count" + 1 WHERE "id" = ${eventId}`,
    `Event ${eventId}`,
  );
}
