// Real-PostgreSQL suites (Phase 15E.4b): `npm run test:db`.
// Needs TEST_DATABASE_URL — a disposable LOCAL database whose name contains
// "test" (CI provides a throwaway service container). See test/db/support.ts.
/** @type {import('jest').Config} */
module.exports = {
  rootDir: '.',
  testEnvironment: 'node',
  moduleFileExtensions: ['js', 'json', 'ts'],
  testMatch: ['<rootDir>/test/db/**/*.db-spec.ts'],
  setupFiles: ['reflect-metadata'],
  transform: {
    '^.+\\.ts$': 'ts-jest',
  },
  globalSetup: '<rootDir>/test/db/global-setup.js',
  // One suite at a time: they share (and truncate) one database.
  maxWorkers: 1,
  testTimeout: 60_000,
};
