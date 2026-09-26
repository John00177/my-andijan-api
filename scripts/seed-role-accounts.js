// One-off: create/update one demo account per role tier, all sharing the
// same password, so each role's permissions can be exercised end-to-end.
//   railway ssh "cd /app && SEED_ROLE_PASSWORD='...' node scripts/seed-role-accounts.js"
//
// Plain CommonJS .js (not .ts) — runs directly with `node`, no ts-node
// compile step needed for a one-shot seed like this.
const bcrypt = require('bcrypt');
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

// 12 rounds to match BCRYPT_ROUNDS in src/auth/auth.service.ts — every other
// password hash in this app uses that cost factor, so these do too.
const BCRYPT_ROUNDS = 12;

// Supplied per-run via the environment, deliberately with NO default: this
// script writes SUPER_ADMIN credentials, so a hardcoded (or defaulted) value
// would be a committed production secret. Exit rather than guess.
const PLAIN_PASSWORD = process.env.SEED_ROLE_PASSWORD;
if (!PLAIN_PASSWORD) {
  console.error('SEED_ROLE_PASSWORD is required. Refusing to run without it.');
  process.exit(1);
}

const USERS = [
  { phone: '+998994796431', fullName: 'Jamoliddin', role: 'SUPER_ADMIN' },
  { phone: '+998991111111', fullName: 'Admin User', role: 'ADMIN' },
  { phone: '+998992222222', fullName: 'Moderator User', role: 'MODERATOR' },
  { phone: '+998993333333', fullName: 'Support User', role: 'SUPPORT' },
  { phone: '+998994444444', fullName: 'Business Owner', role: 'BUSINESS_OWNER' },
  { phone: '+998995555555', fullName: 'Customer User', role: 'CUSTOMER' },
];

async function main() {
  const passwordHash = await bcrypt.hash(PLAIN_PASSWORD, BCRYPT_ROUNDS);

  for (const u of USERS) {
    const result = await prisma.user.upsert({
      where: { phone: u.phone },
      update: { role: u.role, passwordHash, fullName: u.fullName },
      create: { phone: u.phone, fullName: u.fullName, role: u.role, passwordHash },
    });
    console.log(`✓ ${result.phone} -> ${result.role} (id=${result.id})`);
  }

  // The password is NOT echoed: this script's output goes to Railway's log
  // stream, and printing it there would re-create the leak the env var closes.
  console.log('\n========================================');
  console.log('All accounts set to the supplied SEED_ROLE_PASSWORD.');
  console.log('========================================\n');

  const verify = await prisma.user.findMany({
    where: { phone: { in: USERS.map((u) => u.phone) } },
    select: { phone: true, fullName: true, role: true },
    orderBy: { id: 'asc' },
  });
  console.log('VERIFY:');
  console.table(verify);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
