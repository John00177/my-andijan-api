import { execFileSync, spawnSync } from 'child_process';
import { createHash, randomBytes } from 'crypto';
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { PRIVILEGES_DIR } from './privileges';

// SIG Gate 2 — R-E4 tooling of RUNBOOK.md §8 (db/privileges/r-e4/), findings
// I-1…I-4. Everything runs locally on synthetic data: the production command
// (remote-dump.sh) is executed by `sh` with a stand-in pg_dump, exactly as the
// container would run it. No database is needed, except for the end-to-end
// restore check at the bottom, which runs only when G2_R_E4_PG18_BIN names a
// PostgreSQL 18 bin directory (it creates and destroys its own clusters).

const R_E4 = join(PRIVILEGES_DIR, 'r-e4');
const BASH = process.env.G2_BASH ?? 'bash';
const RUNBOOK = readFileSync(join(PRIVILEGES_DIR, 'RUNBOOK.md'), 'utf8');
const fwd = (p: string) => p.replace(/\\/g, '/'); // Git Bash and Linux both accept C:/… or /…

type Run = { status: number; stdout: string; stderr: string };
function bash(script: string, env: Record<string, string> = {}): Run {
  const r = spawnSync(BASH, ['-c', script], { env: { ...process.env, ...env }, encoding: 'utf8', timeout: 120_000 });
  return { status: r.status ?? -1, stdout: r.stdout, stderr: r.stderr };
}
const tool = (name: string) => fwd(join(R_E4, name));
const nonce = () => randomBytes(8).toString('hex');
const sha256 = (b: Buffer) => createHash('sha256').update(b).digest('hex');

let work: string;
beforeAll(() => {
  work = mkdtempSync(join(tmpdir(), 'g2-r-e4-'));
  for (const f of ['unframe-dump.sh', 'counts.sh', 'restore-check.sh']) chmodSync(join(R_E4, f), 0o755);
});
afterAll(() => rmSync(work, { recursive: true, force: true }));

/** remote-dump.sh with this run's nonce, as RUNBOOK §8 builds it. */
function remoteCommand(n: string): string {
  return readFileSync(join(R_E4, 'remote-dump.sh'), 'utf8').replace(/\r?\n/g, '').replace(/@NONCE@/g, n);
}

/** Runs the production command under `sh` with a stand-in pg_dump printing `payload` and exiting `exit`. */
function framedStream(n: string, payload: Buffer, exit = 0): string {
  const dir = mkdtempSync(join(work, 'shim-'));
  writeFileSync(join(dir, 'payload.bin'), payload);
  writeFileSync(join(dir, 'pg_dump'), '#!/bin/sh\ncat "$G2_SHIM_FILE"; exit "${G2_SHIM_EXIT:-0}"\n');
  chmodSync(join(dir, 'pg_dump'), 0o755);
  const r = bash('PATH="$(cygpath -u "$SHIM_DIR" 2>/dev/null || echo "$SHIM_DIR"):$PATH" sh -c "$REMOTE"', {
    SHIM_DIR: fwd(dir),
    G2_SHIM_FILE: fwd(join(dir, 'payload.bin')),
    G2_SHIM_EXIT: String(exit),
    REMOTE: remoteCommand(n),
  });
  return r.stdout;
}

/** unframe-dump.sh on `stream`; returns the run and the decoded bytes (if any). */
function unframe(stream: string, n: string): Run & { out?: Buffer } {
  const dir = mkdtempSync(join(work, 'unframe-'));
  writeFileSync(join(dir, 'framed.txt'), stream);
  const out = join(dir, 'out.dump');
  const r = bash(`"${tool('unframe-dump.sh')}" "${fwd(join(dir, 'framed.txt'))}" "${n}" "${fwd(out)}"`);
  const leftovers = readdirSync(dir).filter((f) => f !== 'framed.txt' && f !== 'out.dump');
  expect(leftovers).toEqual([]); // no .partial/.payload residue, ever
  return { ...r, out: existsSync(out) ? readFileSync(out) : undefined };
}

const dumpLike = (size = 200_000) => Buffer.concat([Buffer.from('PGDMP'), randomBytes(size)]);

describe('R-E4 framed dump transport (I-2, I-3)', () => {
  it('the production command is pinned in RUNBOOK §8 and stays far below the transport limit', () => {
    const bytes = Buffer.from(readFileSync(join(R_E4, 'remote-dump.sh'), 'utf8').replace(/\r\n/g, '\n'));
    const pinned = RUNBOOK.match(/^\| `r-e4\/remote-dump\.sh` \| `([0-9a-f]{64})` \|\r?$/m)?.[1];
    expect(pinned).toBe(sha256(bytes));
    expect(remoteCommand(nonce()).length).toBeLessThan(1_000);
  });

  it('a valid framed stream decodes to the exact bytes, ignoring the CLI notice and CR line endings outside the frame', () => {
    const n = nonce();
    const payload = dumpLike();
    const stream = `Using SSH key from file C:\\Users\\x\\.ssh\\id_ed25519.pub: railway-cli\n${framedStream(n, payload)}Connection closed.\n`;
    const r = unframe(stream.replace(/\n/g, '\r\n'), n);
    expect(r).toMatchObject({ status: 0 });
    expect(r.stdout).toMatch(/1 before BEGIN, 1 after END/);
    expect(sha256(r.out!)).toBe(sha256(payload));
  });

  it('fails closed on any non-payload line inside the frame (stderr noise, an injected marker)', () => {
    const n = nonce();
    const lines = framedStream(n, dumpLike()).split('\n');
    for (const intruder of ['pg_dump: warning: something', `G2RE4-END ${n} pg_dump_exit=0`, 'QUJD QUJD']) {
      const tampered = [...lines.slice(0, 4), intruder, ...lines.slice(4)].join('\n');
      const r = unframe(tampered, n);
      expect(r.status).toBe(1);
      expect(r.out).toBeUndefined();
      expect(r.stderr).toMatch(/G2-STOP R-E4 unframe/);
    }
  });

  it('fails closed on a truncated stream (cut mid-payload, or before END)', () => {
    const n = nonce();
    const lines = framedStream(n, dumpLike()).split('\n');
    for (const cut of [lines.slice(0, Math.floor(lines.length / 2)), lines.slice(0, -2)]) {
      const r = unframe(cut.join('\n'), n);
      expect(r.status).toBe(1);
      expect(r.out).toBeUndefined();
      expect(r.stderr).toMatch(/truncated|END marker missing/);
    }
  });

  it('fails closed when a payload line is lost (the remote line count no longer matches)', () => {
    const n = nonce();
    const lines = framedStream(n, dumpLike()).split('\n');
    const r = unframe([...lines.slice(0, 5), ...lines.slice(6)].join('\n'), n);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/line count marker does not match/);
  });

  it('fails closed when pg_dump exits non-zero, even though base64 output arrived', () => {
    const n = nonce();
    const r = unframe(framedStream(n, dumpLike(), 1), n);
    expect(r.status).toBe(1);
    expect(r.out).toBeUndefined();
    expect(r.stderr).toMatch(/pg_dump exit status 1/);
  });

  it('cannot be satisfied by a stale or foreign frame: the nonce is per run', () => {
    const r = unframe(framedStream(nonce(), dumpLike()), nonce());
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/another run|BEGIN marker for this nonce not found/);
  });

  it('fails closed on a second frame after END, on a payload that is not a pg_dump archive, and on a bad nonce', () => {
    const n = nonce();
    const stream = framedStream(n, dumpLike());
    expect(unframe(stream + stream, n).stderr).toMatch(/frame marker after END/);
    expect(unframe(framedStream(n, randomBytes(5_000)), n).stderr).toMatch(/not a pg_dump custom-format archive/);
    expect(unframe(stream, 'NOT-A-NONCE').stderr).toMatch(/16 lowercase hexadecimal/);
  });
});

describe('R-E4 row counts (I-1)', () => {
  const PROD_RAW = [
    'Using SSH key from file C:\\x: railway-cli',
    'BEGIN',
    'WARNING:  there is already a transaction in progress',
    '_prisma_migrations|16',
    'users|250',
    'businesses|40',
    'ROLLBACK',
    'WARNING:  there is no transaction in progress',
  ].join('\r\n');
  const RESTORE_RAW = 'businesses|40\n_prisma_migrations|16\nusers|250\n';

  function counts(prodRaw: string, restoreRaw: string): Run {
    const dir = mkdtempSync(join(work, 'counts-'));
    writeFileSync(join(dir, 'prod.raw'), prodRaw);
    writeFileSync(join(dir, 'restore.raw'), restoreRaw);
    const d = fwd(dir);
    return bash(
      `"${tool('counts.sh')}" normalize "${d}/prod.raw" "${d}/prod.counts" && ` +
        `"${tool('counts.sh')}" normalize "${d}/restore.raw" "${d}/restore.counts" && ` +
        `"${tool('counts.sh')}" compare "${d}/prod.counts" "${d}/restore.counts"`,
    );
  }

  it('production output with psql command tags, warnings and the CLI notice matches identical restore counts', () => {
    const r = counts(PROD_RAW, RESTORE_RAW);
    expect(r).toMatchObject({ status: 0 });
    expect(r.stdout).toMatch(/MATCH \(3 tables/);
    expect(r.stdout).toMatch(/5 non-row lines dropped/);
  });

  it('a genuine per-table difference is reported and fails (2: explain or repeat)', () => {
    const r = counts(PROD_RAW, RESTORE_RAW.replace('users|250', 'users|249'));
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/users: 250 vs 249/);
  });

  it('a _prisma_migrations difference or a different table set is a hard STOP (1)', () => {
    expect(counts(PROD_RAW, RESTORE_RAW.replace('_prisma_migrations|16', '_prisma_migrations|15')).status).toBe(1);
    expect(counts(PROD_RAW, RESTORE_RAW.replace('businesses|40\n', '')).status).toBe(1);
    expect(counts(PROD_RAW, `${RESTORE_RAW}extra_table|1\n`).status).toBe(1);
  });

  it('malformed rows, duplicates, a missing _prisma_migrations or an empty result fail closed', () => {
    expect(counts(`${PROD_RAW}\r\nusers|abc`, RESTORE_RAW).stderr).toMatch(/malformed/);
    expect(counts(`${PROD_RAW}\r\nusers|250`, RESTORE_RAW).stderr).toMatch(/more than once/);
    expect(counts(PROD_RAW.replace('_prisma_migrations|16', ''), RESTORE_RAW).stderr).toMatch(/_prisma_migrations missing/);
    expect(counts('BEGIN\r\nROLLBACK', RESTORE_RAW).stderr).toMatch(/no table\|count rows/);
  });

  // Regression (PR #18 review, 2026-10-06): `grep -F '|' | grep -vqE` under
  // pipefail let a malformed row through on large inputs — grep -q exits at the
  // first match, the producer dies of SIGPIPE (141) and the `if` read that as
  // "no match". Inputs of ~250 KB, far beyond any pipe buffer, and several runs
  // each, because that failure was timing-dependent.
  describe('large inputs (no early-exit fail-open)', () => {
    const RUNS = 5;
    const ROWS = 20_000;
    const big = (insert: string, at: 'beginning' | 'middle' | 'end'): string => {
      const rows = Array.from({ length: ROWS }, (_, i) => `t${i}|${i}`);
      const pos = at === 'beginning' ? 0 : at === 'middle' ? ROWS / 2 : ROWS;
      rows.splice(pos, 0, insert);
      return ['BEGIN', '_prisma_migrations|16', ...rows, 'ROLLBACK'].join('\r\n');
    };
    const normalizeOnly = (raw: string): Run => {
      const dir = mkdtempSync(join(work, 'big-'));
      writeFileSync(join(dir, 'prod.raw'), raw);
      const r = bash(`"${tool('counts.sh')}" normalize "${fwd(join(dir, 'prod.raw'))}" "${fwd(join(dir, 'prod.counts'))}"`);
      expect(readdirSync(dir).filter((f) => f.includes('.tmp.'))).toEqual([]); // temp files always removed
      return r;
    };

    it.each(['beginning', 'middle', 'end'] as const)('a malformed row at the %s of a large input always fails closed', (at) => {
      for (let i = 0; i < RUNS; i++) {
        const r = normalizeOnly(big('users|abc', at));
        expect({ run: i, status: r.status }).toEqual({ run: i, status: 1 });
        expect(r.stderr).toMatch(/malformed table\|count row/);
      }
    });

    it('a corrupted count or a duplicated table hidden in a large input always fails closed', () => {
      for (let i = 0; i < RUNS; i++) {
        expect(normalizeOnly(big('users|25O', 'middle')).stderr).toMatch(/malformed table\|count row/);
        const dup = normalizeOnly(big('t12345|12345', 'end'));
        expect(dup.status).toBe(1);
        expect(dup.stderr).toMatch(/listed more than once in .*: t12345/);
      }
    });

    it('a large well-formed input still normalizes completely (not over-strict)', () => {
      const r = normalizeOnly(big('users|250', 'middle'));
      expect(r).toMatchObject({ status: 0 });
      expect(r.stdout).toMatch(new RegExp(`${ROWS + 2} tables normalized; 2 non-row lines dropped`));
    });
  });
});

describe('R-E4 disposable restore check (I-4)', () => {
  it('refuses without the encrypted-storage confirmation, and for files outside R_E4_DIR', () => {
    const dir = fwd(mkdtempSync(join(work, 'guard-')));
    writeFileSync(join(dir, 'x.dump'), 'PGDMP');
    writeFileSync(join(dir, 'prod.counts'), '_prisma_migrations|1\n');
    const run = (env: Record<string, string>, dump = `${dir}/x.dump`) =>
      bash(`"${tool('restore-check.sh')}" "${dump}" "${dir}/prod.counts"`, { R_E4_DIR: dir, ...env });
    expect(run({}).stderr).toMatch(/R_E4_ENCRYPTED_STORAGE_CONFIRMED=yes/);
    const outside = fwd(join(work, 'outside.dump'));
    writeFileSync(outside, 'PGDMP');
    expect(run({ R_E4_ENCRYPTED_STORAGE_CONFIRMED: 'yes' }, outside).stderr).toMatch(/inside R_E4_DIR/);
  });

  // End to end with real PostgreSQL 18 binaries (local only; CI has none):
  // a disposable SOURCE cluster stands in for production — every migration,
  // synthetic rows, real pg_dump through remote-dump.sh — then the full R-E4
  // chain. Both clusters are destroyed.
  const PG18 = process.env.G2_R_E4_PG18_BIN;
  (PG18 ? it : it.skip)(
    'end to end on PostgreSQL 18: framed real dump → unframe → counts → restore-check MATCH; a later write gives 2; cleanup leaves nothing',
    () => {
      const pg = fwd(PG18!);
      const store = fwd(mkdtempSync(join(work, 'encrypted-store-')));
      const src = `${store}/source-pgdata`;
      const port = '55498';
      const srcEnv = { PGHOST: 'localhost', PGPORT: port, PGUSER: 'postgres' };
      const sql30 = fwd(join(PRIVILEGES_DIR, '30_rowcounts_readonly.sql'));
      const sh = (s: string, env: Record<string, string> = {}) => {
        const r = bash(s, env);
        if (r.status !== 0) throw new Error(`${s}\n${r.stdout}\n${r.stderr}`);
        return r;
      };
      const prodCounts = (name: string) => {
        // RUNBOOK §6 read-only invocation shape (BEGIN/ROLLBACK tags and warnings included), then normalized
        sh(`"${pg}/psql" -X -v ON_ERROR_STOP=1 -At -d railway -c 'BEGIN TRANSACTION READ ONLY' -f "${sql30}" -c 'ROLLBACK' > "${store}/${name}.raw" 2>&1 </dev/null`, srcEnv);
        sh(`"${tool('counts.sh')}" normalize "${store}/${name}.raw" "${store}/${name}.counts"`);
      };
      try {
        sh(`"${pg}/initdb" -D "${src}" -U postgres -A trust -E UTF8 --locale=C >/dev/null 2>&1 </dev/null`);
        sh(`"${pg}/pg_ctl" -D "${src}" -o "-p ${port} -c listen_addresses=localhost" -l "${src}.log" -w start >/dev/null 2>&1 </dev/null`);
        sh(`"${pg}/createdb" railway </dev/null`, srcEnv);
        execFileSync('npx', ['prisma', 'migrate', 'deploy'], {
          cwd: join(PRIVILEGES_DIR, '..', '..'),
          env: {
            ...process.env,
            DATABASE_URL: `postgresql://postgres@localhost:${port}/railway`,
            MIGRATION_DATABASE_URL: `postgresql://postgres@localhost:${port}/railway`,
          },
          stdio: 'ignore',
          shell: process.platform === 'win32',
        });
        sh(`"${pg}/psql" -X -q -d railway -c "INSERT INTO users (phone, password_hash, full_name, updated_at) SELECT '+9989000' || lpad(g::text, 5, '0'), 'synthetic', 'Synthetic ' || g, now() FROM generate_series(1, 120) g" </dev/null`, srcEnv);

        const n = nonce();
        sh(`PATH="$(cygpath -u "${pg}" 2>/dev/null || echo "${pg}"):$PATH" sh -c "$REMOTE" > "${store}/railway.framed"`, { ...srcEnv, REMOTE: remoteCommand(n) });
        expect(sh(`"${tool('unframe-dump.sh')}" "${store}/railway.framed" ${n} "${store}/railway.dump"`).stdout).toMatch(/unframe: OK/);
        prodCounts('prod');

        const env = { R_E4_DIR: store, R_E4_ENCRYPTED_STORAGE_CONFIRMED: 'yes', PG18_BIN: pg, R_E4_PORT: '55499' };
        const ok = bash(`"${tool('restore-check.sh')}" "${store}/railway.dump" "${store}/prod.counts"`, env);
        expect(ok).toMatchObject({ status: 0 });
        expect(ok.stdout).toMatch(/pg_restore completed/);
        expect(ok.stdout).toMatch(/MATCH \(\d+ tables/);
        expect(ok.stdout).toMatch(/cleanup done/);
        expect(readdirSync(store).filter((f) => f.startsWith('restore-pgdata'))).toEqual([]);

        // A write after the dump: the production count no longer matches the restored copy.
        sh(`"${pg}/psql" -X -q -d railway -c "INSERT INTO users (phone, password_hash, full_name, updated_at) VALUES ('+998900099999', 'synthetic', 'Late', now())" </dev/null`, srcEnv);
        prodCounts('prod2');
        const diff = bash(`"${tool('restore-check.sh')}" "${store}/railway.dump" "${store}/prod2.counts"`, env);
        expect(diff.status).toBe(2);
        expect(diff.stderr).toMatch(/users: 121 vs 120/);
        expect(diff.stdout).toMatch(/cleanup done/);
        expect(readdirSync(store).filter((f) => f.startsWith('restore-pgdata'))).toEqual([]);
      } finally {
        bash(`"${pg}/pg_ctl" -D "${src}" -m fast -w stop >/dev/null 2>&1 </dev/null`);
        rmSync(store, { recursive: true, force: true });
      }
    },
    300_000,
  );
});
