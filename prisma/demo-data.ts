// ============================================================================
// DEMO DATA  —  test fixture for the health-score engine.
//
// prisma/seed.ts intentionally seeds only reference data (geography, taxonomy,
// the admin account) — it creates no businesses, so there is nothing for the
// scoring algorithm to score. This script adds four businesses chosen to land
// in four different health bands, which is what makes the scores verifiable
// rather than merely present.
//
// Safe to re-run: everything is upserted on a stable slug/phone.
// Run with:  npx ts-node prisma/demo-data.ts
// ============================================================================

import { BusinessStatus, EventStatus, PrismaClient, ReviewStatus, UserRole } from '@prisma/client';
import * as bcrypt from 'bcrypt';

const prisma = new PrismaClient();

const HOURS = [0, 1, 2, 3, 4, 5].map((d) => ({ dayOfWeek: d, openTime: '09:00', closeTime: '21:00' }));

function daysAgo(n: number): Date {
  return new Date(Date.now() - n * 86_400_000);
}

function plusSeconds(d: Date, s: number): Date {
  return new Date(d.getTime() + s * 1000);
}

async function upsertUser(phone: string, fullName: string, role: UserRole) {
  const passwordHash = await bcrypt.hash('DemoPass123!', 10);
  return prisma.user.upsert({
    where: { phone },
    update: {},
    create: { phone, fullName, role, passwordHash, phoneVerified: true },
  });
}

async function main() {
  console.log('Seeding demo businesses for health-score testing...');

  const [category, businessType, district] = await Promise.all([
    prisma.category.findFirstOrThrow({ orderBy: { id: 'asc' } }),
    prisma.businessType.findFirstOrThrow({ where: { catalogEnabled: true }, orderBy: { id: 'asc' } }),
    prisma.district.findFirstOrThrow({ orderBy: { id: 'asc' } }),
  ]);

  const owner = await upsertUser('+998901110001', 'Demo Owner', UserRole.BUSINESS_OWNER);

  // Reviewers must be distinct users: Review has @@unique([branchId, userId]).
  const reviewers = await Promise.all(
    Array.from({ length: 12 }, (_, i) =>
      upsertUser(`+9989012000${String(i).padStart(2, '0')}`, `Demo Reviewer ${i + 1}`, UserRole.CUSTOMER),
    ),
  );

  // ---- 1. HEALTHY: complete profile, engaged, promoted, replies fast ----------
  const healthy = await prisma.business.upsert({
    where: { slug: 'demo-registon-restorani' },
    update: {},
    create: {
      ownerId: owner.id,
      categoryId: category.id,
      businessTypeId: businessType.id,
      slug: 'demo-registon-restorani',
      name: 'Registon Restorani',
      description:
        "Registon Restorani — Andijon markazidagi milliy taomlar restorani. Bizda an'anaviy osh, shashlik, lagmon va somsa tayyorlanadi. Katta zal 120 kishiga mo'ljallangan, to'y va yubileylar uchun alohida xona mavjud. Har kuni yangi mahsulotlardan tayyorlanadi, buyurtma qabul qilamiz.",
      coverUrl: 'https://cdn.myandijan.uz/demo/registon-cover.jpg',
      telegram: '@registon_restorani',
      instagram: 'registon_andijon',
      status: BusinessStatus.APPROVED,
      isVerified: true,
      isPromoted: true,
      promotedUntil: new Date(Date.now() + 30 * 86_400_000),
      isFeatured: true,
      featuredUntil: new Date(Date.now() + 30 * 86_400_000),
    },
  });

  const healthyBranch = await prisma.branch.upsert({
    where: { businessId_slug: { businessId: healthy.id, slug: 'markaziy' } },
    update: {},
    create: {
      businessId: healthy.id,
      districtId: district.id,
      name: 'Markaziy filial',
      slug: 'markaziy',
      address: 'Andijon shahri, Navoiy shoh ko\'chasi 12',
      landmark: 'Eski bozor ro\'parasida',
      phone: '+998742231122',
      isPrimary: true,
    },
  });

  for (const h of HOURS) {
    await prisma.branchHour.upsert({
      where: { branchId_dayOfWeek: { branchId: healthyBranch.id, dayOfWeek: h.dayOfWeek } },
      update: {},
      create: { branchId: healthyBranch.id, ...h },
    });
  }

  if ((await prisma.branchPhoto.count({ where: { branchId: healthyBranch.id } })) === 0) {
    await prisma.branchPhoto.createMany({
      data: [1, 2, 3, 4].map((i) => ({
        branchId: healthyBranch.id,
        url: `https://cdn.myandijan.uz/demo/registon-${i}.jpg`,
        sortOrder: i,
        isPrimary: i === 1,
      })),
    });
  }

  // 8 reviews, high ratings, every one replied to within ~30 minutes.
  for (const [i, reviewer] of reviewers.slice(0, 8).entries()) {
    const createdAt = daysAgo(20 - i);
    const review = await prisma.review.upsert({
      where: { branchId_userId: { branchId: healthyBranch.id, userId: reviewer.id } },
      update: {},
      create: {
        branchId: healthyBranch.id,
        userId: reviewer.id,
        rating: i < 6 ? 5 : 4,
        comment: 'Juda mazali osh va tez xizmat. Oilaviy tashrif uchun ideal joy.',
        status: ReviewStatus.PUBLISHED,
        createdAt,
      },
    });
    await prisma.reviewReply.upsert({
      where: { reviewId: review.id },
      update: {},
      create: {
        reviewId: review.id,
        authorId: owner.id,
        body: 'Rahmat! Sizni yana kutamiz.',
        createdAt: plusSeconds(createdAt, 1800),
      },
    });
  }

  for (const reviewer of reviewers.slice(0, 12)) {
    await prisma.favorite.upsert({
      where: { userId_businessId: { userId: reviewer.id, businessId: healthy.id } },
      update: {},
      create: { userId: reviewer.id, businessId: healthy.id },
    });
  }

  await prisma.product.upsert({
    where: { businessId_slug: { businessId: healthy.id, slug: 'osh' } },
    update: {},
    create: { businessId: healthy.id, name: 'Osh', slug: 'osh', price: 35000, currency: 'UZS' },
  });

  await prisma.event.upsert({
    where: { slug: 'demo-registon-ochilish' },
    update: {},
    create: {
      businessId: healthy.id,
      districtId: district.id,
      slug: 'demo-registon-ochilish',
      title: 'Yangi zal ochilishi',
      description: 'Yangi banket zalining ochilish marosimi va chegirmalar kuni.',
      startAt: new Date(Date.now() + 7 * 86_400_000),
      endAt: new Date(Date.now() + 7 * 86_400_000 + 4 * 3_600_000),
      status: EventStatus.PUBLISHED,
      publishedAt: new Date(),
    },
  });

  // ---- 2. MIDDLING: decent profile, reviews but slow/partial replies ----------
  const middling = await prisma.business.upsert({
    where: { slug: 'demo-andijon-tekstil' },
    update: {},
    create: {
      ownerId: owner.id,
      categoryId: category.id,
      businessTypeId: businessType.id,
      slug: 'demo-andijon-tekstil',
      name: 'Andijon Tekstil',
      description: 'Paxta matolar ishlab chiqarish va ulgurji savdo.',
      coverUrl: 'https://cdn.myandijan.uz/demo/tekstil-cover.jpg',
      telegram: '@andijon_tekstil',
      status: BusinessStatus.APPROVED,
      isVerified: true,
    },
  });

  const middlingBranch = await prisma.branch.upsert({
    where: { businessId_slug: { businessId: middling.id, slug: 'zavod' } },
    update: {},
    create: {
      businessId: middling.id,
      districtId: district.id,
      name: 'Zavod',
      slug: 'zavod',
      address: 'Andijon tumani, Sanoat ko\'chasi 5',
      phone: '+998742234455',
      isPrimary: true,
    },
  });

  for (const h of HOURS.slice(0, 5)) {
    await prisma.branchHour.upsert({
      where: { branchId_dayOfWeek: { branchId: middlingBranch.id, dayOfWeek: h.dayOfWeek } },
      update: {},
      create: { branchId: middlingBranch.id, ...h },
    });
  }

  // 4 reviews; only 1 replied to, and that one took 4 days.
  for (const [i, reviewer] of reviewers.slice(0, 4).entries()) {
    const createdAt = daysAgo(15 - i);
    const review = await prisma.review.upsert({
      where: { branchId_userId: { branchId: middlingBranch.id, userId: reviewer.id } },
      update: {},
      create: {
        branchId: middlingBranch.id,
        userId: reviewer.id,
        rating: i === 0 ? 3 : 4,
        comment: 'Sifat yaxshi, lekin yetkazib berish kechikdi.',
        status: ReviewStatus.PUBLISHED,
        createdAt,
      },
    });
    if (i === 0) {
      await prisma.reviewReply.upsert({
        where: { reviewId: review.id },
        update: {},
        create: {
          reviewId: review.id,
          authorId: owner.id,
          body: 'Izohingiz uchun rahmat, kamchilikni bartaraf qildik.',
          createdAt: plusSeconds(createdAt, 4 * 86_400),
        },
      });
    }
  }

  // ---- 3. BARE: brand-new listing, nothing filled in --------------------------
  const bare = await prisma.business.upsert({
    where: { slug: 'demo-yangi-dokon' },
    update: {},
    create: {
      ownerId: owner.id,
      categoryId: category.id,
      businessTypeId: businessType.id,
      slug: 'demo-yangi-dokon',
      name: "Yangi Do'kon",
      status: BusinessStatus.APPROVED,
    },
  });

  await prisma.branch.upsert({
    where: { businessId_slug: { businessId: bare.id, slug: 'asosiy' } },
    update: {},
    create: {
      businessId: bare.id,
      districtId: district.id,
      name: 'Asosiy',
      slug: 'asosiy',
      address: 'Andijon shahri, Bobur ko\'chasi 1',
      phone: '+998742239900',
      isPrimary: true,
    },
  });

  // ---- 4. NEGLECTED: lots of unanswered reviews, poor rating ------------------
  const neglected = await prisma.business.upsert({
    where: { slug: 'demo-osh-markazi' },
    update: {},
    create: {
      ownerId: owner.id,
      categoryId: category.id,
      businessTypeId: businessType.id,
      slug: 'demo-osh-markazi',
      name: 'Osh Markazi',
      description: 'Milliy taomlar.',
      status: BusinessStatus.APPROVED,
    },
  });

  const neglectedBranch = await prisma.branch.upsert({
    where: { businessId_slug: { businessId: neglected.id, slug: 'asosiy' } },
    update: {},
    create: {
      businessId: neglected.id,
      districtId: district.id,
      name: 'Asosiy',
      slug: 'asosiy',
      address: 'Andijon shahri, Cho\'lpon ko\'chasi 40',
      phone: '+998742237788',
      isPrimary: true,
    },
  });

  for (const [i, reviewer] of reviewers.slice(0, 7).entries()) {
    await prisma.review.upsert({
      where: { branchId_userId: { branchId: neglectedBranch.id, userId: reviewer.id } },
      update: {},
      create: {
        branchId: neglectedBranch.id,
        userId: reviewer.id,
        rating: i < 5 ? 2 : 3,
        comment: 'Uzoq kutdik, javob ham bermadilar.',
        status: ReviewStatus.PUBLISHED,
        createdAt: daysAgo(10 - i),
      },
    });
  }

  console.log('Demo data ready:');
  for (const b of [healthy, middling, bare, neglected]) {
    console.log(`  #${b.id}  ${b.name}  (${b.slug})`);
  }
  console.log(`Owner login: ${owner.phone} / DemoPass123!`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
