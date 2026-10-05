// Jest globalSetup for SIG Gate 2 runtime mode (npm run test:db:runtime).
// 1. The normal setup: safety checks + every migration, as the superuser.
// 2. db/privileges/10_phase_a_boundary.sql, unchanged — the production Phase A.
//    Its preflight refuses (G2-STOP A0) if Gate 2 roles already exist in this
//    cluster, so roles this run did not create are never touched.
// 3. What Phase B does in production: runtime_app_public may log in. Here
//    WITHOUT a password — only CI's local trust authentication lets it connect.
const { execFileSync } = require('node:child_process');
const { join } = require('node:path');
const migrate = require('./global-setup');

const PRIVILEGES_DIR = join(__dirname, '..', '..', 'db', 'privileges');

/** `prisma db execute` against the test database; throws with PostgreSQL's message on failure. */
function dbExecute(args, input) {
  try {
    execFileSync('npx', ['prisma', 'db', 'execute', ...args, '--url', process.env.TEST_DATABASE_URL], {
      input,
      stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
      shell: process.platform === 'win32', // npx is a .cmd shim on Windows
      timeout: 120_000,
    });
  } catch (error) {
    throw new Error(`prisma db execute ${args.join(' ')} failed:\n${error.stdout ?? ''}${error.stderr ?? ''}`);
  }
}

module.exports = async () => {
  await migrate();
  dbExecute(['--file', join(PRIVILEGES_DIR, '10_phase_a_boundary.sql')]);
  dbExecute(['--stdin'], 'ALTER ROLE runtime_app_public LOGIN;');
};
module.exports.dbExecute = dbExecute;
module.exports.PRIVILEGES_DIR = PRIVILEGES_DIR;
