// Jest globalTeardown for SIG Gate 2 runtime mode (npm run test:db:runtime):
// takes LOGIN away again and runs db/privileges/90_rollback_phase_a.sql,
// unchanged, so the cluster is left without Gate 2 roles. The rollback refuses
// while a runtime session is still connected; the test workers have exited,
// but their backends can take a moment to go, so it is retried briefly.
const { join } = require('node:path');
const { dbExecute, PRIVILEGES_DIR } = require('./runtime-global-setup');

module.exports = async () => {
  dbExecute(['--stdin'], 'ALTER ROLE runtime_app_public NOLOGIN;');
  const deadline = Date.now() + 15_000;
  for (;;) {
    try {
      dbExecute(['--file', join(PRIVILEGES_DIR, '90_rollback_phase_a.sql')]);
      return;
    } catch (error) {
      if (!/sessions are connected/.test(String(error)) || Date.now() > deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
};
