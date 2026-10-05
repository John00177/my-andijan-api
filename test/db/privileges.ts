import { PrismaClient } from '@prisma/client';
import { execFileSync } from 'child_process';
import { readFileSync } from 'fs';
import { join } from 'path';

// SIG Gate 2 — helpers for the database privilege boundary (db/privileges/).
// The suites run the reviewed SQL files themselves, byte for byte, so what CI
// proves is exactly what the owner runs in production.

const REPO_ROOT = join(__dirname, '..', '..');
export const PRIVILEGES_DIR = join(REPO_ROOT, 'db', 'privileges');

export const SQL = {
  preflight: join(PRIVILEGES_DIR, '00_preflight_readonly.sql'),
  phaseA: join(PRIVILEGES_DIR, '10_phase_a_boundary.sql'),
  verify: join(PRIVILEGES_DIR, '20_verify_readonly.sql'),
  rowCounts: join(PRIVILEGES_DIR, '30_rowcounts_readonly.sql'),
  rollback: join(PRIVILEGES_DIR, '90_rollback_phase_a.sql'),
};

/** The SIG Gate 1 §12 role set Phase A creates. */
export const GATE2_ROLES = [
  'migration_owner',
  'runtime_app_public',
  'runtime_app_staff',
  'sig_audit_owner',
  'sig_audit_writer',
  'sig_audit_reader',
  'sig_context_purger',
  'sig_retention_job',
  'sig_governance_writer',
  'sig_anchor_recorder',
  'sig_anchor_publisher',
] as const;

/**
 * Runs a multi-statement SQL file with `prisma db execute` (what an operator
 * gets from psql -f: the file's own BEGIN/COMMIT, DO blocks, RAISE). Returns
 * the outcome instead of throwing; output is kept for assertions, never printed.
 */
export function executeSqlFile(file: string, databaseUrl: string): { ok: boolean; output: string } {
  try {
    const output = execFileSync('npx', ['prisma', 'db', 'execute', '--file', file, '--url', databaseUrl], {
      cwd: REPO_ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: process.platform === 'win32', // npx is a .cmd shim on Windows
      timeout: 120_000,
    });
    return { ok: true, output: String(output) };
  } catch (error) {
    const e = error as { stdout?: Buffer; stderr?: Buffer };
    return { ok: false, output: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  }
}

/** Gate 2 roles present in the cluster (roles are cluster-wide, not per database). */
export async function existingGate2Roles(db: Pick<PrismaClient, '$queryRawUnsafe'>): Promise<string[]> {
  const rows = await db.$queryRawUnsafe<Array<{ rolname: string }>>(
    `SELECT rolname FROM pg_roles WHERE rolname = ANY ($1::text[]) ORDER BY rolname`,
    [...GATE2_ROLES],
  );
  return rows.map((row) => row.rolname);
}

export type VerifyRow = { id: string; result: 'PASS' | 'FAIL' | 'INFO'; title: string; detail: string | null };

/** db/privileges/20_verify_readonly.sql — one row per check. */
export function verify(db: Pick<PrismaClient, '$queryRawUnsafe'>): Promise<VerifyRow[]> {
  return db.$queryRawUnsafe<VerifyRow[]>(readFileSync(SQL.verify, 'utf8'));
}

/** The checks that did not pass (INFO rows excluded). */
export function failures(rows: VerifyRow[]): VerifyRow[] {
  return rows.filter((row) => row.result === 'FAIL');
}
