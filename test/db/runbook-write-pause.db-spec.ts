import { readFileSync } from 'fs';
import { join } from 'path';
import { PRIVILEGES_DIR, SQL } from './privileges';

// SIG Gate 2 — the R-E4 write pause of db/privileges/RUNBOOK.md §8 (owner
// decision, 2026-10-06). The pause is an operator procedure in Railway, so
// these checks keep its documented invariants from drifting:
// - the W0–W9 order;
// - the resume returns to the deployment recorded at W0, never hard-coded here;
// - W3 proves the removed deployment is still rollback-eligible;
// - a W3, W4, W5 or W6 failure stops without an automatic resume or rollback, and
//   W7 needs the owner's explicit authorization;
// - the restore uses the approved PostgreSQL 18.6 binaries;
// - the window runs read-only SQL only, and no configuration, session or deploy command;
// - P4 excludes the operator's own session.
// No database is needed.

const RUNBOOK = readFileSync(join(PRIVILEGES_DIR, 'RUNBOOK.md'), 'utf8').replace(/\r\n/g, '\n');

/** The "Write pause and resume" block of §8, up to R-E4 step 1. */
function pauseSection(): string {
  const start = RUNBOOK.indexOf('### Write pause and resume');
  const end = RUNBOOK.indexOf('\n1. **Set up**', start);
  if (start < 0 || end < 0) throw new Error('RUNBOOK.md §8 has no write-pause section before step 1');
  return RUNBOOK.slice(start, end);
}

/** `| Wn | … |` rows of the window sequence, keyed by step, in document order. */
function windowSteps(section: string): Map<string, string> {
  return new Map([...section.matchAll(/^\| (W\d) \|.*$/gm)].map(([row, step]) => [step, row]));
}

/** `| <item> | \`<value>\` |` from the recorded-deployment table. */
function recorded(section: string, item: string): string | undefined {
  return section.match(new RegExp(`^\\| ${item} \\| \`([^\`]+)\` \\|$`, 'm'))?.[1];
}

/** The "Failure handling" bullet starting with `label`, continuation lines joined. */
function failureBullet(section: string, label: string): string | undefined {
  return section
    .split('\n- ')
    .map((bullet) => bullet.replace(/\n\s+/g, ' '))
    .find((bullet) => bullet.startsWith(label));
}

const DEPLOYMENT = '<RECORDED_DEPLOYMENT_ID>';
const COMMIT = '<RECORDED_COMMIT_SHA>';

describe('SIG Gate 2 R-E4 write pause (RUNBOOK.md §8)', () => {
  const section = pauseSection();
  const steps = windowSteps(section);

  it('runs W0…W9 in order: freeze, preflight, pause, verify, dump, re-verify, local restore, resume, verify, lift', () => {
    expect([...steps.keys()]).toEqual(['W0', 'W1', 'W2', 'W3', 'W4', 'W5', 'W6', 'W7', 'W8', 'W9']);
    const expected: Array<[string, RegExp]> = [
      ['W0', /merge\/deploy freeze/],
      ['W1', /`00_preflight_readonly\.sql`.*`30_rowcounts_readonly\.sql`.*-At/],
      ['W2', /\*\*Remove\*\*/],
      ['W3', /P4 returns \*\*0 rows\*\*.*does \*\*not\*\* answer 200.*STOP/],
      ['W4', /R-E4 steps 1–4/],
      ['W5', /P4 still returns \*\*0 rows\*\*.*the dump is not used/],
      ['W6', /18\.6.*`restore-check\.sh` exits \*\*0\*\*/],
      ['W7', /\*\*Rollback\*\*/],
      ['W8', /`SUCCESS`.*answers \*\*200\*\*/],
      ['W9', /Lift the merge\/deploy freeze/],
    ];
    for (const [step, pattern] of expected) expect({ step, row: steps.get(step) }).toEqual({ step, row: expect.stringMatching(pattern) });
  });

  it('resumes by Rollback to exactly the deployment recorded at W0, never by Redeploy and never to main', () => {
    expect(recorded(section, 'Deployment')).toBe(DEPLOYMENT);
    expect(recorded(section, 'Commit')).toBe(COMMIT);
    // W0 records the live deployment in the session log; W7 rolls back to it; W8 confirms its commit.
    expect(steps.get('W0')).toContain(`\`${DEPLOYMENT}\` / commit \`${COMMIT}\` in \`SESSION_LOG.md\``);
    expect(steps.get('W7')).toContain(
      `select the recorded removed deployment \`${DEPLOYMENT}\` and use ⋮ → **Rollback** on that deployment`,
    );
    expect(steps.get('W7')).toContain('**Never Redeploy**');
    expect(steps.get('W7')).toContain('**never deploy `main`**');
    expect(steps.get('W7')).toContain('**never substitute another deployment**');
    expect(steps.get('W7')).toContain('Verify the resulting active deployment');
    expect(steps.get('W8')).toContain(`on commit \`${COMMIT}\``);
  });

  it('W3 proves the removed deployment is still rollback-eligible, and a W3 failure stops without an automatic resume', () => {
    const w3 = steps.get('W3');
    expect(w3).toContain(`the recorded deployment \`${DEPLOYMENT}\` is in state **\`REMOVED\`**`);
    expect(w3).toContain('**still present in the deployment history**');
    expect(w3).toContain('**still offers ⋮ → Rollback**');
    expect(w3).toContain('Otherwise **STOP R-E4**: do not continue to W4, and do **not** proceed automatically to W7');
    expect(w3).toContain("only on the owner's **explicit confirmation**");
    expect(w3).not.toMatch(/STOP and resume|continue with W7/);

    const atW3 = failureBullet(section, '**A STOP at W3:**');
    expect(atW3).toBeDefined();
    for (const required of [
      'do **not** proceed automatically to W7',
      "W7 and W8 run only on the owner's **explicit confirmation**",
      'do not deploy `main`',
      'do not create a replacement deployment',
      'do not improvise a recovery path',
      'The hard stop still holds',
    ])
      expect({ required, atW3 }).toEqual({ required, atW3: expect.stringContaining(required) });
    // No rule may route a W3 failure straight into the Rollback any more.
    expect(section).not.toContain('A STOP after W2 and before W7');
    // Stop condition 11 covers a lost rollback target.
    expect(RUNBOOK).toContain(
      'after the Remove, the recorded deployment is not `REMOVED`, is missing from the deployment history, or has no Rollback action',
    );
  });

  it.each([
    ['W4', 'Otherwise **STOP R-E4**: a partial or failed dump is not used; do **not** proceed automatically to W7'],
    ['W5', 'Otherwise **STOP R-E4**: the dump is not used; do **not** proceed automatically to W7'],
    ['W6', 'Otherwise **STOP R-E4**: do **not** proceed automatically to W7'],
  ])('a %s failure stops R-E4 and waits for the owner: no automatic resume or rollback', (step, stop) => {
    const row = steps.get(step);
    expect(row).toContain(stop);
    expect(row).toContain(
      "and do **not** roll back automatically; resume (W7, W8) only on the owner's **explicit confirmation**",
    );
    expect(row).not.toMatch(/continue with W7|STOP and resume|go (straight )?to W7/);

    const bullet = failureBullet(section, `**A STOP at ${step}** (`);
    expect(bullet).toBeDefined();
    for (const required of [
      'R-E4 stops and is not met',
      'Do **not** proceed automatically to W7 and do **not** roll back automatically',
      "W7 and W8 run only on the owner's **explicit confirmation**",
      'The hard stop still holds: no production remediation, SQL privilege change, credential or variable change, migration, emergency code change or replacement deployment',
    ])
      expect({ step, required, bullet }).toEqual({ step, required, bullet: expect.stringContaining(required) });
    if (step === 'W4') expect(bullet).toContain('a partial or failed dump is not used');
  });

  it('keeps the W5 PASS path, and nothing routes a STOP to W7 automatically: W7 needs the owner', () => {
    expect(steps.get('W5')).toContain('P4 still returns **0 rows**, and **no** deployment or build has appeared.');
    expect(steps.get('W7')).toContain("**Resume**, only on the owner's **explicit authorization:**");
    expect(failureBullet(section, '**W7 itself**')).toContain("only on the owner's **explicit authorization**");
    expect(section).not.toMatch(/A STOP (after W\d and before W7|at W4 or W6)|go (straight )?to W7/);
  });

  it('never hard-codes a production deployment ID or commit SHA: they are recorded per window', () => {
    expect(section).not.toMatch(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i);
    // Any hex token of 7+ characters with both a digit and a letter (an abbreviated or full commit SHA).
    expect(section).not.toMatch(/\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,40}\b/);
  });

  it('restores with the approved PostgreSQL 18.6 binaries, set explicitly and checked by version', () => {
    expect(RUNBOOK).toMatch(/^ {3}export R_E4_DIR=.* PG18_BIN=D:\/PostgreSQL-18\.6\/pgsql\/bin;/m);
    expect(RUNBOOK).toContain('`"$PG18_BIN/postgres" --version` must print 18.6, otherwise STOP');
    expect(steps.get('W6')).toContain('`"$PG18_BIN/postgres" --version`');
  });

  it('runs only the read-only preflight and row-count SQL', () => {
    const files = new Set([...section.matchAll(/\b\d\d_[a-z0-9_]+\.sql\b/g)].map(([file]) => file));
    expect([...files].sort()).toEqual(['00_preflight_readonly.sql', '30_rowcounts_readonly.sql']);
  });

  it('contains no database-configuration, session-termination, privilege, migration or deployment command', () => {
    const forbidden =
      /pg_terminate_backend|pg_cancel_backend|ALTER\s+(DATABASE|SYSTEM|ROLE)|default_transaction_read_only|\bGRANT\b|\bREVOKE\b|prisma\s+migrate|railway\s+(up|redeploy|down|variables)/i;
    expect(section).not.toMatch(forbidden);
  });

  it('P4 = 0 rows means no other client: the preflight P4 query excludes the operator’s own session', () => {
    const lines = readFileSync(SQL.preflight, 'utf8').replace(/\r\n/g, '\n').split('\n');
    const p4 = lines.findIndex((line) => line.startsWith('-- P4 '));
    expect(p4).toBeGreaterThanOrEqual(0);
    expect(lines[p4 + 1]).toMatch(/FROM pg_stat_activity\b.*\bpid <> pg_backend_pid\(\)/);
  });

  it('the production counts use the §6 read-only invocation plus -At, nothing else', () => {
    const readOnly = RUNBOOK.split('\n')
      .find((line) => line.startsWith('| read-only ('))
      ?.match(/\| `([^`]+)` \|$/)?.[1];
    const withAt = RUNBOOK.match(/^ {3}`(PGOPTIONS=[^`]* -At [^`]*)`$/m)?.[1];
    expect(readOnly).toBeDefined();
    expect(withAt?.replace(' -At ', ' ')).toBe(readOnly);
  });
});
