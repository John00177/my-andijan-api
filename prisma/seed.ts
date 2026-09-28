import { PrismaClient, UserRole, UserStatus, Language } from '@prisma/client';
import * as bcrypt from 'bcrypt';

const prisma = new PrismaClient();

function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/['’ʻʼ`]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

// ============================================================================
// GEOGRAPHY DATA
// ============================================================================

// 14 tumans (districts) + 1 city of regional subordination (Andijon shahri,
// seeded separately below as the region-level City "Andijon") = 15
// administrative-territorial units total in the region. "Andijon shahri" is
// NOT a tuman — Andijon tumani (admin center: Kuyganyor) is the real 14th one.
const DISTRICTS = [
  'Andijon tumani',
  'Asaka',
  'Baliqchi',
  "Bo'ston",
  'Buloqboshi',
  'Izboskan',
  'Jalaquduq',
  "Xo'jaobod",
  'Qurghontepa',
  'Marhamat',
  "Oltinko'l",
  'Paxtabad',
  'Shahrixon',
  "Ulug'nor",
];

// Cities that share a name with a district get linked to that district by
// name match. Andijon is the region-level exception: districtId stays null.
const CITIES: { name: string; regionLevel: boolean }[] = [
  { name: 'Andijon', regionLevel: true },
  { name: 'Asaka', regionLevel: false },
  { name: 'Baliqchi', regionLevel: false },
  { name: "Bo'ston", regionLevel: false },
  { name: 'Buloqboshi', regionLevel: false },
  { name: 'Izboskan', regionLevel: false },
  { name: 'Jalaquduq', regionLevel: false },
  { name: "Xo'jaobod", regionLevel: false },
  { name: 'Qurghontepa', regionLevel: false },
  { name: 'Marhamat', regionLevel: false },
  { name: 'Shahrixon', regionLevel: false },
];

const CATEGORIES = [
  { nameUz: 'Oziq-ovqat', nameRu: 'Еда и напитки', nameEn: 'Food & Drink', icon: 'utensils' },
  { nameUz: "Sog'liq", nameRu: 'Здоровье', nameEn: 'Health', icon: 'heart-pulse' },
  { nameUz: 'Sotuv', nameRu: 'Магазины', nameEn: 'Shopping', icon: 'shopping-bag' },
  { nameUz: "Ta'lim", nameRu: 'Образование', nameEn: 'Education', icon: 'graduation-cap' },
  { nameUz: 'Xizmatlar', nameRu: 'Услуги', nameEn: 'Services', icon: 'wrench' },
  { nameUz: "Go'zallik", nameRu: 'Красота', nameEn: 'Beauty', icon: 'sparkles' },
  { nameUz: 'Avto', nameRu: 'Авто', nameEn: 'Auto', icon: 'car' },
  { nameUz: "Ko'chmas mulk", nameRu: 'Недвижимость', nameEn: 'Real Estate', icon: 'building-2' },
];

const BUSINESS_TYPES = [
  {
    nameUz: 'Restoran',
    nameRu: 'Ресторан',
    nameEn: 'Restaurant',
    catalogEnabled: true,
  },
  {
    nameUz: 'Kafe',
    nameRu: 'Кафе',
    nameEn: 'Cafe',
    catalogEnabled: true,
  },
  {
    nameUz: "Do'kon",
    nameRu: 'Магазин',
    nameEn: 'Store',
    catalogEnabled: true,
  },
  {
    nameUz: 'Klinika',
    nameRu: 'Клиника',
    nameEn: 'Clinic',
    catalogEnabled: true,
    bookingEnabled: false,
  },
  {
    nameUz: "Go'zallik saloni",
    nameRu: 'Салон красоты',
    nameEn: 'Beauty Salon',
    catalogEnabled: true,
    bookingEnabled: false,
  },
  {
    nameUz: "Ta'lim markazi",
    nameRu: 'Учебный центр',
    nameEn: 'Education Center',
    catalogEnabled: true,
    bookingEnabled: false,
  },
  {
    nameUz: 'Avto servis',
    nameRu: 'Автосервис',
    nameEn: 'Auto Service',
    catalogEnabled: true,
    bookingEnabled: false,
  },
  {
    nameUz: "Ko'chmas mulk agentligi",
    nameRu: 'Агентство недвижимости',
    nameEn: 'Real Estate Agency',
    catalogEnabled: false,
  },
  {
    nameUz: 'Mehmonxona',
    nameRu: 'Гостиница',
    nameEn: 'Hotel',
    catalogEnabled: true,
    bookingEnabled: false,
  },
  {
    nameUz: 'Fitnes markazi',
    nameRu: 'Фитнес-центр',
    nameEn: 'Fitness Center',
    catalogEnabled: true,
    bookingEnabled: false,
  },
];

async function seedRegion() {
  const region = await prisma.region.upsert({
    where: { slug: 'andijon' },
    update: {},
    create: {
      slug: 'andijon',
      nameUz: 'Andijon viloyati',
      nameRu: 'Андижанская область',
      nameEn: 'Andijan Region',
      sortOrder: 0,
    },
  });
  console.log(`Region ready: ${region.nameUz}`);
  return region;
}

// One-time repair for the "Andijon shahri" bug: that row was wrongly seeded
// as a District. Branch.districtId and Event.districtId are onDelete:
// Restrict, and branch1 + 2 events already reference it, so it can't just be
// deleted and recreated. Renaming it in place to "Andijon tumani" preserves
// every existing FK. Idempotent: once renamed, the slug lookup finds nothing
// on subsequent runs and this is a no-op.
async function migrateAndijonShahriDistrict() {
  const legacy = await prisma.district.findUnique({ where: { slug: 'andijon-shahri' } });
  if (!legacy) return;

  await prisma.district.update({
    where: { id: legacy.id },
    data: { slug: 'andijon-tumani', nameUz: 'Andijon tumani', nameRu: 'Andijon tumani', nameEn: 'Andijon tumani' },
  });
  console.log(
    `Migrated legacy "Andijon shahri" district (id=${legacy.id}) -> "Andijon tumani" (existing branch/event references preserved)`,
  );
}

async function seedDistricts(regionId: number) {
  await migrateAndijonShahriDistrict();

  const districts: Record<string, { id: number }> = {};

  for (let i = 0; i < DISTRICTS.length; i++) {
    const nameUz = DISTRICTS[i];
    const slug = slugify(nameUz);
    const district = await prisma.district.upsert({
      where: { slug },
      update: {},
      create: {
        regionId,
        slug,
        nameUz,
        nameRu: nameUz,
        nameEn: nameUz,
        sortOrder: i,
      },
    });
    districts[nameUz] = { id: district.id };
  }

  console.log(`Districts ready: ${DISTRICTS.length}`);
  return districts;
}

async function seedCities(regionId: number, districts: Record<string, { id: number }>) {
  let count = 0;

  for (let i = 0; i < CITIES.length; i++) {
    const { name, regionLevel } = CITIES[i];
    const slug = slugify(name);

    // Match the city to its same-named district (e.g. Asaka city <->
    // Asaka district). Andijon is region-level — it sits directly under the
    // region, outside the tuman hierarchy entirely — so districtId stays null.
    const districtId = regionLevel ? null : (districts[name]?.id ?? null);

    await prisma.city.upsert({
      where: { slug },
      update: {},
      create: {
        regionId,
        districtId,
        isRegionLevel: regionLevel,
        slug,
        nameUz: name,
        nameRu: name,
        nameEn: name,
        sortOrder: i,
      },
    });
    count++;
  }

  console.log(`Cities ready: ${count}`);
}

async function seedCategories() {
  for (let i = 0; i < CATEGORIES.length; i++) {
    const c = CATEGORIES[i];
    const slug = slugify(c.nameUz);
    await prisma.category.upsert({
      where: { slug },
      update: {},
      create: {
        slug,
        nameUz: c.nameUz,
        nameRu: c.nameRu,
        nameEn: c.nameEn,
        icon: c.icon,
        showOnHomepage: true,
        sortOrder: i,
      },
    });
  }
  console.log(`Categories ready: ${CATEGORIES.length}`);
}

async function seedBusinessTypes() {
  for (let i = 0; i < BUSINESS_TYPES.length; i++) {
    const t = BUSINESS_TYPES[i];
    const slug = slugify(t.nameUz);
    await prisma.businessType.upsert({
      where: { slug },
      update: {},
      create: {
        slug,
        nameUz: t.nameUz,
        nameRu: t.nameRu,
        nameEn: t.nameEn,
        catalogEnabled: t.catalogEnabled ?? false,
        eventsEnabled: true,
        advertisingEnabled: true,
        bookingEnabled: false,
        inventoryEnabled: false,
        warehouseEnabled: false,
        deliveryEnabled: false,
        orderingEnabled: false,
        sortOrder: i,
      },
    });
  }
  console.log(`Business types ready: ${BUSINESS_TYPES.length}`);
}

async function seedAdmin() {
  const phone = process.env.SEED_ADMIN_PHONE ?? '+998900000000';
  const email = process.env.SEED_ADMIN_EMAIL ?? 'admin@myandijan.uz';

  // No fallback, deliberately. This creates an ADMIN account, so a default
  // value here would be a working admin password published in the repository,
  // and an unconfigured seed run would silently create a weak account. The
  // phone and email above are safe to default; a credential is not.
  const password = process.env.SEED_ADMIN_PASSWORD;
  if (!password) {
    throw new Error(
      'SEED_ADMIN_PASSWORD is required to seed the admin account. Set it and re-run.',
    );
  }

  const passwordHash = await bcrypt.hash(password, 12);

  const admin = await prisma.user.upsert({
    where: { phone },
    update: {},
    create: {
      phone,
      email,
      passwordHash,
      fullName: 'Platform Admin',
      role: UserRole.ADMIN,
      status: UserStatus.ACTIVE,
      phoneVerified: true,
      emailVerified: true,
      preferredLanguage: Language.UZ,
    },
  });

  console.log(`Admin ready: ${admin.phone}`);
}

async function main() {
  console.log('Seeding My Andijan database...');

  const region = await seedRegion();
  const districts = await seedDistricts(region.id);
  await seedCities(region.id, districts);
  await seedCategories();
  await seedBusinessTypes();
  await seedAdmin();

  console.log('Seed complete.');
}

main()
  .catch((error) => {
    console.error('Seed failed:', error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
