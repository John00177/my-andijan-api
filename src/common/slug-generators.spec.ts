import { Test } from '@nestjs/testing';
import { AdminService } from '../admin/admin.service';
import { EventsService } from '../events/events.service';
import { HealthScoreService } from '../health-score/health-score.service';
import { OwnerService } from '../owner/owner.service';
import { PrismaService } from '../prisma/prisma.service';
import { ProductsService } from '../products/products.service';
import { ReviewsService } from '../reviews/reviews.service';

// Phase 16F.2: every slug generator goes through the shared slugBase/slugify,
// so Cyrillic names get real slugs, collisions still suffix, an all-digit
// name can never become a slug that GET /businesses/:idOrSlug reads as an ID,
// and Latin names slug as they always did. The generators are private; they
// are exercised directly against a mock of the uniqueness lookup each uses.

/** A findUnique mock answering "taken" for every slug in `taken`. */
function takenLookup(taken: string[], pick: (where: Record<string, unknown>) => string) {
  return jest.fn(({ where }: { where: Record<string, unknown> }) =>
    Promise.resolve(taken.includes(pick(where)) ? { id: 1 } : null),
  );
}

describe('slug generators (Phase 16F.2)', () => {
  describe('OwnerService — business slugs (GET /businesses/:idOrSlug)', () => {
    async function make(taken: string[] = []) {
      const prisma = {
        business: { findUnique: takenLookup(taken, (w) => w.slug as string) },
        branch: { findUnique: takenLookup(taken, (w) => (w.businessId_slug as { slug: string }).slug) },
      };
      const moduleRef = await Test.createTestingModule({
        providers: [
          OwnerService,
          { provide: PrismaService, useValue: prisma },
          { provide: ReviewsService, useValue: {} },
          { provide: EventsService, useValue: {} },
          { provide: HealthScoreService, useValue: {} },
        ],
      }).compile();
      return moduleRef.get(OwnerService);
    }

    it('transliterates a Cyrillic name instead of collapsing it to "business"', async () => {
      const service = await make();
      await expect(service['generateUniqueBusinessSlug']('Сой миллий таомлар')).resolves.toBe('soy-milliy-taomlar');
    });

    it('gives two different Cyrillic names two meaningful slugs, not business / business-2', async () => {
      const service = await make(['soy-milliy-taomlar']);
      await expect(service['generateUniqueBusinessSlug']('Кўк чой')).resolves.toBe('kok-choy');
    });

    it('suffixes a Cyrillic name that collides with an existing Latin slug', async () => {
      const service = await make(['soy', 'soy-2']);
      await expect(service['generateUniqueBusinessSlug']('Сой')).resolves.toBe('soy-3');
    });

    it('slugs an existing-style Latin name exactly as before', async () => {
      const service = await make(['soy-milliy-taomlar']);
      await expect(service['generateUniqueBusinessSlug']('Soy milliy taomlar')).resolves.toBe('soy-milliy-taomlar-2');
    });

    it('never produces an all-digit slug that would be read as a business ID', async () => {
      const service = await make(['business-777']);
      const slug = await service['generateUniqueBusinessSlug']('777');
      expect(slug).toBe('business-777-2');
      expect(slug).not.toMatch(/^\d+$/);
    });

    it('still falls back for a name with nothing slug-worthy', async () => {
      const service = await make(['business']);
      await expect(service['generateUniqueBusinessSlug']('!!!')).resolves.toBe('business-2');
    });

    it('transliterates branch names and suffixes per business', async () => {
      const service = await make(['asaka-filiali']);
      await expect(service['generateUniqueBranchSlug'](5, 'Асака филиали')).resolves.toBe('asaka-filiali-2');
    });
  });

  describe('EventsService — event slugs', () => {
    async function make(taken: string[] = []) {
      const prisma = { event: { findUnique: takenLookup(taken, (w) => w.slug as string) } };
      const moduleRef = await Test.createTestingModule({
        providers: [EventsService, { provide: PrismaService, useValue: prisma }],
      }).compile();
      return moduleRef.get(EventsService);
    }

    it('transliterates a Cyrillic title and keeps the numeric rule', async () => {
      const service = await make(['event-2026']);
      await expect(service['generateUniqueSlug']('Наврўз байрами')).resolves.toBe('navroz-bayrami');
      await expect(service['generateUniqueSlug']('2026')).resolves.toBe('event-2026-2');
    });
  });

  describe('ProductsService — menu item slugs', () => {
    it('transliterates a Cyrillic name and suffixes on collision within the business', async () => {
      const prisma = {
        product: { findUnique: takenLookup(['osh'], (w) => (w.businessId_slug as { slug: string }).slug) },
      };
      const moduleRef = await Test.createTestingModule({
        providers: [ProductsService, { provide: PrismaService, useValue: prisma }],
      }).compile();
      const service = moduleRef.get(ProductsService);

      await expect(service['generateUniqueSlug'](5, 'Ош')).resolves.toBe('osh-2');
      await expect(service['generateUniqueSlug'](5, 'Манти')).resolves.toBe('manti');
    });
  });

  describe('AdminService.createCategory — category slugs', () => {
    async function createWith(dto: Record<string, unknown>) {
      const prisma: { $transaction: jest.Mock; category: { create: jest.Mock }; auditLog: { create: jest.Mock } } = {
        $transaction: jest.fn(),
        category: { create: jest.fn(({ data }: { data: object }) => Promise.resolve({ id: 9, ...data })) },
        auditLog: { create: jest.fn() },
      };
      // createCategory writes the row and its audit entry in one callback-form
      // transaction; run the callback against the same mock.
      prisma.$transaction.mockImplementation((fn: (tx: unknown) => unknown) => fn(prisma));
      const moduleRef = await Test.createTestingModule({
        providers: [
          AdminService,
          { provide: PrismaService, useValue: prisma },
          { provide: ReviewsService, useValue: {} },
        ],
      }).compile();
      await moduleRef.get(AdminService).createCategory(1, dto as never);
      return prisma.category.create.mock.calls[0][0].data.slug;
    }

    it('transliterates a Cyrillic category name instead of producing an empty slug', async () => {
      await expect(createWith({ nameUz: 'Нонвойхона' })).resolves.toBe('nonvoyxona');
    });

    it('keeps an explicit Latin slug as before', async () => {
      await expect(createWith({ nameUz: 'Nonvoyxona', slug: 'Oziq-ovqat' })).resolves.toBe('oziq-ovqat');
    });
  });
});
