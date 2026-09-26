// Pre-launch data reset. Defaults to a DRY RUN that only counts what would
// be deleted — pass --confirm to actually execute.
//
// Run against production via Railway's own env injection so no production
// credentials ever need to be pasted or stored locally:
//   railway run npx ts-node scripts/cleanup-db.ts            (dry run)
//   railway run npx ts-node scripts/cleanup-db.ts --confirm   (execute)
//
// Deletion scope, in dependency order (children before parents so no FK
// constraint or unwanted SetNull orphaning gets in the way):
//   1. Businesses where status = PENDING, or owned by a user about to be
//      deleted (step 5). Hard delete — cascades to Branch/Product/Event/
//      Favorite/BusinessClaim/BusinessAnalytics/BusinessHealthScore per
//      schema.prisma's onDelete: Cascade.
//   2. ALL reviews (branch-cascaded ones from step 1 are already gone; this
//      catches any left on businesses NOT being deleted).
//   3. OTP / password-reset codes older than 24h.
//   4. Categories not in the 8 real seeded slugs (only succeeds if nothing
//      still references them — Category->Business is onDelete: Restrict by
//      design, so this fails loudly instead of silently orphaning).
//   5. Every user except KEEP_PHONE.
//
// Districts are intentionally NOT touched — the spec says "keep the real 14",
// not "delete the fake ones", and Region/City/Branch/User all carry FKs into
// District that are too risky to blanket-clear from a script.
import { PrismaClient, BusinessStatus } from '@prisma/client';

const prisma = new PrismaClient();

const KEEP_PHONE = '+998994796431';

const REAL_CATEGORY_SLUGS = [
  'oziq-ovqat',
  'sogliq',
  'sotuv',
  'talim',
  'xizmatlar',
  'gozallik',
  'avto',
  'kochmas-mulk',
];

const confirm = process.argv.includes('--confirm');

async function main() {
  const keepUser = await prisma.user.findUnique({ where: { phone: KEEP_PHONE } });
  if (!keepUser) {
    throw new Error(`KEEP_PHONE ${KEEP_PHONE} not found — refusing to run (would delete every user).`);
  }

  const usersToDelete = await prisma.user.findMany({
    where: { phone: { not: KEEP_PHONE } },
    select: { id: true, phone: true, fullName: true, role: true },
  });
  const userIdsToDelete = usersToDelete.map((u) => u.id);

  const businessesToDelete = await prisma.business.findMany({
    where: {
      OR: [{ status: BusinessStatus.PENDING }, { ownerId: { in: userIdsToDelete } }],
    },
    select: { id: true, name: true, status: true, ownerId: true },
  });
  const businessIdsToDelete = businessesToDelete.map((b) => b.id);

  const reviewCount = await prisma.review.count();
  const staleOtpCount = await prisma.otpCode.count({
    where: { createdAt: { lt: new Date(Date.now() - 24 * 60 * 60 * 1000) } },
  });
  const fakeCategories = await prisma.category.findMany({
    where: { slug: { notIn: REAL_CATEGORY_SLUGS } },
    select: { id: true, slug: true, nameUz: true },
  });

  console.log('==================== CLEANUP PLAN ====================');
  console.log(`Keep user: ${keepUser.fullName} (${keepUser.phone}), id=${keepUser.id}, role=${keepUser.role}`);
  console.log(`\nUsers to DELETE: ${usersToDelete.length}`);
  for (const u of usersToDelete.slice(0, 20)) console.log(`  - [${u.id}] ${u.phone} "${u.fullName}" (${u.role})`);
  if (usersToDelete.length > 20) console.log(`  ...and ${usersToDelete.length - 20} more`);

  console.log(`\nBusinesses to DELETE: ${businessIdsToDelete.length}`);
  for (const b of businessesToDelete.slice(0, 20)) console.log(`  - [${b.id}] "${b.name}" (${b.status})`);
  if (businessesToDelete.length > 20) console.log(`  ...and ${businessesToDelete.length - 20} more`);

  console.log(`\nReviews to DELETE (ALL): ${reviewCount}`);
  console.log(`OTP/reset codes older than 24h to DELETE: ${staleOtpCount}`);

  console.log(`\nCategories NOT in the real 8 (to DELETE): ${fakeCategories.length}`);
  for (const c of fakeCategories) console.log(`  - [${c.id}] ${c.slug} "${c.nameUz}"`);

  console.log('\n=======================================================');

  if (!confirm) {
    console.log('DRY RUN — no changes made. Re-run with --confirm to execute.');
    return;
  }

  console.log('\nEXECUTING...');

  if (businessIdsToDelete.length) {
    const res = await prisma.business.deleteMany({ where: { id: { in: businessIdsToDelete } } });
    console.log(`Deleted ${res.count} businesses (cascaded branches/products/events/reviews/etc.)`);
  }

  const reviewRes = await prisma.review.deleteMany({});
  console.log(`Deleted ${reviewRes.count} remaining reviews`);

  const otpRes = await prisma.otpCode.deleteMany({
    where: { createdAt: { lt: new Date(Date.now() - 24 * 60 * 60 * 1000) } },
  });
  console.log(`Deleted ${otpRes.count} stale OTP codes`);

  if (fakeCategories.length) {
    const catRes = await prisma.category.deleteMany({
      where: { id: { in: fakeCategories.map((c) => c.id) } },
    });
    console.log(`Deleted ${catRes.count} fake categories`);
  }

  if (userIdsToDelete.length) {
    const userRes = await prisma.user.deleteMany({ where: { id: { in: userIdsToDelete } } });
    console.log(`Deleted ${userRes.count} users`);
  }

  console.log('\nDone.');
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
