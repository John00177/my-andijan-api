// Jest globalSetup for the real-PostgreSQL suites (npm run test:db, Phase 15E.4b).
// Applies every committed migration to the disposable test database — which
// also proves the migration chain deploys cleanly on an empty database.
const { execSync } = require('node:child_process');

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

module.exports = async () => {
  const raw = process.env.TEST_DATABASE_URL;
  if (!raw) throw new Error('TEST_DATABASE_URL is not set. The database suites need a disposable local PostgreSQL database.');
  const url = new URL(raw);
  const database = url.pathname.replace(/^\//, '');
  if (!LOCAL_HOSTS.has(url.hostname) || !/test/i.test(database)) {
    throw new Error(`Refusing to migrate: host "${url.hostname}", database "${database}" is not a local test database.`);
  }

  // DATABASE_URL and MIGRATION_DATABASE_URL (the schema's directUrl, which
  // migrations use) are set explicitly for the child, so the Prisma CLI can
  // never pick up a different database from a .env file.
  execSync('npx prisma migrate deploy', {
    env: { ...process.env, DATABASE_URL: raw, MIGRATION_DATABASE_URL: raw },
    stdio: ['ignore', 'ignore', 'inherit'],
  });
};
