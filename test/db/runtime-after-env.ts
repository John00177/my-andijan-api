import { createTestPrisma, disconnectFixtureAdmin } from './support';

// SIG Gate 2 runtime mode (npm run test:db:runtime).

// Fail the suite unless the application's client really connects as the
// runtime role — a misconfiguration must never pass by testing as the superuser.
beforeAll(async () => {
  const probe = createTestPrisma();
  try {
    const [{ who, superuser }] = await probe.$queryRawUnsafe<Array<{ who: string; superuser: boolean }>>(
      `SELECT current_user AS who, (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AS superuser`,
    );
    if (who !== process.env.TEST_DB_RUNTIME_ROLE || superuser) {
      throw new Error(`runtime mode: the application connects as "${who}" (superuser: ${superuser}), not ${process.env.TEST_DB_RUNTIME_ROLE}`);
    }
  } finally {
    await probe.$disconnect();
  }
});

// Close the superuser fixture client (used only for TRUNCATE between tests).
afterAll(() => disconnectFixtureAdmin());
