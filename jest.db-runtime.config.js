// SIG Gate 2 runtime mode: `npm run test:db:runtime` (G2-C2).
// The application suites of `npm run test:db` again, with the application's
// client connected as runtime_app_public after db/privileges/10_phase_a_boundary.sql
// has been applied to the disposable test database. Needs TEST_DATABASE_URL
// (local, name contains "test") on a DISPOSABLE cluster with local trust
// authentication — CI's throwaway service container. See test/db/support.ts.
//
// Excluded: the migration suites (they need DDL: that is migration_owner's job,
// not the runtime's) and the privilege-boundary suite (it creates the roles itself).
process.env.TEST_DB_RUNTIME_ROLE = 'runtime_app_public';

const base = require('./jest.db.config');

/** @type {import('jest').Config} */
module.exports = {
  ...base,
  testPathIgnorePatterns: ['/node_modules/', '<rootDir>/test/db/migration-', '<rootDir>/test/db/privilege-boundary'],
  globalSetup: '<rootDir>/test/db/runtime-global-setup.js',
  globalTeardown: '<rootDir>/test/db/runtime-global-teardown.js',
  setupFilesAfterEnv: ['<rootDir>/test/db/runtime-after-env.ts'],
};
