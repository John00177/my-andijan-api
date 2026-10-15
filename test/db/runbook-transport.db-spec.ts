import { createHash } from 'crypto';
import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { gzipSync } from 'zlib';
import { PRIVILEGES_DIR } from './privileges';

// SIG Gate 2, F-6 — db/privileges/RUNBOOK.md §6 transport. Production SQL
// travels gzip + base64 through `railway ssh`, which truncates a command at
// about 8 KB, and runs only if its SHA-256 equals the fingerprint published in
// the runbook. These checks keep that table and the files in step, and every
// file's guarded command below the runbook's 7,500-character limit.
// No database is needed.

const RUNBOOK = readFileSync(join(PRIVILEGES_DIR, 'RUNBOOK.md'), 'utf8');
const LIMIT = 7_500;
const SQL_FILES = readdirSync(PRIVILEGES_DIR)
  .filter((file) => file.endsWith('.sql'))
  .sort();

/** The committed bytes: git stores LF, while a Windows checkout may hold CRLF. */
function committedBytes(file: string): Buffer {
  return Buffer.from(readFileSync(join(PRIVILEGES_DIR, file), 'utf8').replace(/\r\n/g, '\n'), 'utf8');
}

const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

/** `| \`NN_name.sql\` | \`<sha256>\` |` rows of the §6 fingerprint table. */
function publishedFingerprints(): Map<string, string> {
  const rows = [...RUNBOOK.matchAll(/^\| `(\d\d_[a-z0-9_]+\.sql)` \| `([0-9a-f]{64})` \|\r?$/gm)];
  return new Map(rows.map(([, file, sha]) => [file, sha]));
}

/** The §6 psql invocation for a file's kind (read-only or write). */
function invocationFor(file: string): string {
  const kind = /^(10|90)_/.test(file) ? 'write' : 'read-only';
  const row = RUNBOOK.split(/\r?\n/).find((line) => line.startsWith(`| ${kind} (`));
  const match = row?.match(/\| `([^`]+)` \|$/);
  if (!match) throw new Error(`RUNBOOK.md §6 has no psql invocation row for ${kind} files`);
  return match[1];
}

describe('SIG Gate 2 runbook transport (RUNBOOK.md §6, F-6)', () => {
  it('the fingerprint table lists every SQL file with the SHA-256 of its committed bytes', () => {
    const published = publishedFingerprints();
    expect([...published.keys()].sort()).toEqual(SQL_FILES);
    for (const file of SQL_FILES) {
      expect({ file, sha256: sha256(committedBytes(file)) }).toEqual({ file, sha256: published.get(file) });
    }
  });

  it.each(SQL_FILES)('the guarded gzip + base64 command for %s stays below the transport limit', (file) => {
    const payload = gzipSync(committedBytes(file), { level: 9 }).toString('base64');
    // The command of RUNBOOK.md §6 step 5, as the container receives it.
    const command =
      `P=${payload}; if [ "$(echo $P | base64 -d | gunzip | sha256sum | cut -c1-64)" = ${sha256(committedBytes(file))} ]; ` +
      `then echo $P | base64 -d | gunzip | ${invocationFor(file)}; ` +
      `else echo 'G2-STOP transport: SHA-256 mismatch, nothing executed'; exit 3; fi`;
    expect(command.length).toBeLessThan(LIMIT);
  });
});
