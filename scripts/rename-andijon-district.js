// One-off: rename District id=1 (slug "andijon-tumani") from "Andijon
// tumani" to plain "Andijon", per explicit user confirmation despite this
// making it read identically to the region-level City "Andijon" in any UI
// that lists both.
//   railway ssh "cd /app && node scripts/rename-andijon-district.js"
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  const before = await prisma.district.findUnique({
    where: { slug: 'andijon-tumani' },
    select: { id: true, nameUz: true, nameRu: true, nameEn: true },
  });
  if (!before) throw new Error('District andijon-tumani not found');

  const updated = await prisma.district.update({
    where: { id: before.id },
    data: { nameUz: 'Andijon', nameRu: 'Андижан' },
    select: { id: true, slug: true, nameUz: true, nameRu: true, nameEn: true },
  });

  console.log('Before:', JSON.stringify(before));
  console.log('After: ', JSON.stringify(updated));
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
