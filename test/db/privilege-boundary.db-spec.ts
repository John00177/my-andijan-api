import { PrismaClient } from '@prisma/client';
import { readFileSync, rmSync } from 'fs';
import {
  createTestPrisma,
  deployMigrations,
  inRolledBackTransaction,
  listMigrations,
  migrationsWorkDir,
  recreateDatabase,
  scratchDatabaseUrl,
} from './support';
import { executeSqlFile, existingGate2Roles, failures, GATE2_ROLES, SQL, verify } from './privileges';

// SIG Gate 2 — the database privilege boundary (db/privileges/), proven on
// PostgreSQL 18 against a throwaway database built from every committed
// migration, the way production is today: one superuser owns everything.
//
// Phase A, the verification query and the rollback are the reviewed files the
// owner runs in production, executed unchanged. Roles are cluster-wide, so this
// suite refuses to run if any Gate 2 role already exists (it never touches roles
// it did not create) and always rolls Phase A back before it finishes.

const DML = 'SELECT, INSERT, UPDATE, DELETE';

type Sql = Pick<PrismaClient, '$queryRawUnsafe' | '$executeRawUnsafe'>;

let admin: PrismaClient; // the test database, as the superuser — creates/drops the scratch database
let db: PrismaClient; // the scratch database, as the superuser (the break-glass operator)
let scratch: { url: string; name: string } | undefined;
let rolesCreatedHere = false;

/** Runs `body` as `role` inside a transaction that is rolled back afterwards. */
async function asRole(role: string, body: (tx: Sql) => Promise<void>): Promise<void> {
  await inRolledBackTransaction(db, async (tx) => {
    await tx.$executeRawUnsafe(`SET LOCAL ROLE ${role}`);
    await body(tx);
  });
}

/** Expects `statement`, run as `role`, to be refused by PostgreSQL with `reason`. */
async function expectRefused(role: string, statement: string, reason: RegExp): Promise<void> {
  let refusal: unknown;
  await inRolledBackTransaction(db, async (tx) => {
    await tx.$executeRawUnsafe(`SET LOCAL ROLE ${role}`);
    refusal = await tx.$executeRawUnsafe(statement).then(
      () => 'statement succeeded',
      (error: unknown) => error,
    );
  }).catch((error: unknown) => {
    refusal ??= error; // the refused statement aborts the transaction itself
  });
  expect(String(refusal)).toMatch(reason);
}

async function currentUser(): Promise<string> {
  const [{ me }] = await db.$queryRawUnsafe<Array<{ me: string }>>('SELECT current_user AS me');
  return me;
}

async function ownersOfApplicationRelations(): Promise<string[]> {
  const rows = await db.$queryRawUnsafe<Array<{ owner: string }>>(`
    SELECT DISTINCT pg_get_userbyid(c.relowner) AS owner
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'S')
      AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_class'::regclass AND d.objid = c.oid AND d.deptype = 'e')
    ORDER BY 1`);
  return rows.map((row) => row.owner);
}

describe('SIG Gate 2 database privilege boundary (db/privileges/, PostgreSQL 18)', () => {
  beforeAll(async () => {
    admin = createTestPrisma();
    const present = await existingGate2Roles(admin);
    if (present.length > 0) {
      throw new Error(
        `Refusing to run: Gate 2 roles already exist in this PostgreSQL cluster (${present.join(', ')}). ` +
          'This suite creates and drops them cluster-wide; run it only on a disposable cluster.',
      );
    }
    scratch = scratchDatabaseUrl('privileges');
    await recreateDatabase(admin, scratch.name);
    const workDir = migrationsWorkDir(() => true);
    try {
      const deployed = deployMigrations(workDir, scratch.url);
      if (!deployed.ok) throw new Error(`migrate deploy failed on the scratch database:\n${deployed.output}`);
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
    db = new PrismaClient({ datasources: { db: { url: scratch.url } } });
  }, 180_000);

  afterAll(async () => {
    if (db && scratch && rolesCreatedHere && (await existingGate2Roles(db)).length > 0) {
      await db.$executeRawUnsafe('ALTER ROLE migration_owner NOLOGIN');
      await db.$executeRawUnsafe('ALTER ROLE runtime_app_public NOLOGIN');
      const rolledBack = executeSqlFile(SQL.rollback, scratch.url);
      if (!rolledBack.ok) throw new Error(`cleanup rollback failed:\n${rolledBack.output}`);
    }
    await db?.$disconnect();
    if (scratch) await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${scratch.name}" WITH (FORCE)`);
    await admin?.$disconnect();
  }, 180_000);

  it('the preflight runs read-only on PostgreSQL 18, and the starting state matches production: one superuser owns everything', async () => {
    expect(executeSqlFile(SQL.preflight, scratch!.url)).toMatchObject({ ok: true });
    const [{ version }] = await db.$queryRawUnsafe<Array<{ version: number }>>(
      `SELECT current_setting('server_version_num')::int AS version`,
    );
    expect(version).toBeGreaterThanOrEqual(180000);
    expect(await ownersOfApplicationRelations()).toEqual([await currentUser()]);
    expect(await existingGate2Roles(db)).toEqual([]);
  });

  it('Phase A stops on an unexpected state (a sig_* object already exists) and changes nothing', async () => {
    await db.$executeRawUnsafe('CREATE TABLE sig_unexpected (id int)');
    try {
      const run = executeSqlFile(SQL.phaseA, scratch!.url);
      expect(run.ok).toBe(false);
      expect(run.output).toMatch(/G2-STOP A0: SIG objects already exist/);
      expect(await existingGate2Roles(db)).toEqual([]); // atomic: no role survived the abort
      expect(await ownersOfApplicationRelations()).toEqual([await currentUser()]);
    } finally {
      await db.$executeRawUnsafe('DROP TABLE sig_unexpected');
    }
  });

  it('Phase A applies, and its own self-check (A5) passes', () => {
    const run = executeSqlFile(SQL.phaseA, scratch!.url);
    rolesCreatedHere = run.ok;
    expect(run).toMatchObject({ ok: true });
  });

  it('every verification check passes (G2-C1, G2-C2, G2-C4, INV-DB1/2/3, RB-D1, RB-D3)', async () => {
    const rows = await verify(db);
    expect(failures(rows)).toEqual([]);
    expect(rows.filter((row) => row.result === 'PASS').map((row) => row.id)).toEqual([
      'V01', 'V02', 'V03', 'V04', 'V05', 'V06', 'V07', 'V08', 'V09', 'V10', 'V11', 'V12',
    ]);
    expect(rows.find((row) => row.id === 'V12')?.detail).toBe(`${listMigrations().length} applied`);
  });

  it('roles: all eleven exist, none can log in, none holds a privileged attribute or a membership', async () => {
    const roles = await db.$queryRawUnsafe<Array<{ rolname: string; risky: boolean }>>(
      `SELECT rolname,
              (rolcanlogin OR rolsuper OR rolcreaterole OR rolcreatedb OR rolreplication OR rolbypassrls
               OR EXISTS (SELECT 1 FROM pg_auth_members am WHERE am.roleid = r.oid OR am.member = r.oid)) AS risky
       FROM pg_roles r WHERE rolname = ANY ($1::text[]) ORDER BY rolname`,
      [...GATE2_ROLES],
    );
    expect(roles.map((role) => role.rolname)).toEqual([...GATE2_ROLES].sort());
    expect(roles.filter((role) => role.risky)).toEqual([]);
  });

  it('ownership moved to migration_owner for application objects only; pg_trgm stays with the superuser', async () => {
    expect(await ownersOfApplicationRelations()).toEqual(['migration_owner']);
    const extensionOwners = await db.$queryRawUnsafe<Array<{ owner: string }>>(`
      SELECT DISTINCT pg_get_userbyid(p.proowner) AS owner
      FROM pg_proc p JOIN pg_depend d ON d.classid = 'pg_proc'::regclass AND d.objid = p.oid AND d.deptype = 'e'
      JOIN pg_extension e ON e.oid = d.refobjid WHERE e.extname = 'pg_trgm'`);
    expect(extensionOwners).toEqual([{ owner: await currentUser() }]);
    const enumOwners = await db.$queryRawUnsafe<Array<{ owner: string }>>(`
      SELECT DISTINCT pg_get_userbyid(t.typowner) AS owner
      FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace WHERE n.nspname = 'public' AND t.typtype = 'e'`);
    expect(enumOwners).toEqual([{ owner: 'migration_owner' }]);
  });

  it('runtime_app_public reads and writes application rows (INSERT through a sequence, UPDATE, DELETE) and calls the search functions', async () => {
    await asRole('runtime_app_public', async (tx) => {
      const [{ id }] = await tx.$queryRawUnsafe<Array<{ id: number }>>(
        `INSERT INTO users (phone, password_hash, full_name, updated_at) VALUES ('+998900000901', 'x', 'Runtime', now()) RETURNING id`,
      );
      expect(await tx.$executeRawUnsafe(`UPDATE users SET full_name = 'Runtime 2' WHERE id = ${id}`)).toBe(1);
      const [{ normalized }] = await tx.$queryRawUnsafe<Array<{ normalized: string }>>(
        `SELECT search_normalize('Andijon') AS normalized`,
      );
      expect(typeof normalized).toBe('string');
      expect(await tx.$executeRawUnsafe(`DELETE FROM users WHERE id = ${id}`)).toBe(1);
    });
  });

  it.each([
    ['TRUNCATE', 'TRUNCATE users CASCADE', /permission denied/],
    ['CREATE TABLE', 'CREATE TABLE runtime_ddl (id int)', /permission denied for schema public/],
    ['ALTER TABLE', 'ALTER TABLE users ADD COLUMN runtime_ddl int', /must be owner/],
    ['DROP TABLE', 'DROP TABLE favorites', /must be owner/],
    ['ALTER TYPE', `ALTER TYPE "UserRole" ADD VALUE 'RUNTIME_DDL'`, /must be owner/],
    ['reading _prisma_migrations', 'SELECT count(*) FROM _prisma_migrations', /permission denied/],
    ['writing _prisma_migrations', 'DELETE FROM _prisma_migrations', /permission denied/],
    ['a TEMP table', 'CREATE TEMP TABLE runtime_tmp (id int)', /permission denied to create temporary tables/],
    ['creating a role', 'CREATE ROLE runtime_made', /permission denied to create role/],
  ])('runtime_app_public is refused: %s', async (_name, statement, reason) => {
    await expectRefused('runtime_app_public', statement, reason);
  });

  // SET ROLE is checked against the SESSION user (here the superuser running
  // the suite), so it cannot be exercised through SET LOCAL ROLE; what actually
  // stops a runtime login from becoming another role is having no membership.
  it('runtime_app_public cannot act as migration_owner or any other Gate 2 role (no membership)', async () => {
    const reachable = await db.$queryRawUnsafe<Array<{ rolname: string }>>(
      `SELECT rolname FROM unnest($1::text[]) AS rolname
       WHERE rolname <> 'runtime_app_public' AND pg_has_role('runtime_app_public', rolname, 'MEMBER')`,
      [...GATE2_ROLES],
    );
    expect(reachable).toEqual([]);
  });

  it('migration_owner can run the DDL a future migration needs (columns, tables, indexes, enum values, migration history)', async () => {
    await asRole('migration_owner', async (tx) => {
      await tx.$executeRawUnsafe('ALTER TABLE users ADD COLUMN g2_probe int');
      await tx.$executeRawUnsafe('CREATE TABLE g2_probe (id serial PRIMARY KEY, user_id int REFERENCES users (id))');
      await tx.$executeRawUnsafe('CREATE INDEX g2_probe_user ON g2_probe (user_id)');
      await tx.$executeRawUnsafe(`ALTER TYPE "UserRole" ADD VALUE 'G2_PROBE'`);
      await tx.$executeRawUnsafe('UPDATE _prisma_migrations SET logs = logs WHERE false');
    });
  });

  it('RB-D1 fails closed: a table a later migration creates is invisible to the runtime until that migration grants it explicitly', async () => {
    await inRolledBackTransaction(db, async (tx) => {
      await tx.$executeRawUnsafe('SET LOCAL ROLE migration_owner');
      await tx.$executeRawUnsafe('CREATE TABLE later_feature (id serial PRIMARY KEY, note text)');
      await tx.$executeRawUnsafe('RESET ROLE');
      const before = await tx.$queryRawUnsafe<Array<{ can: boolean }>>(
        `SELECT has_table_privilege('runtime_app_public', 'later_feature', '${DML}') AS can`,
      );
      expect(before).toEqual([{ can: false }]);
      // the CI gate catches the missing grant
      expect(failures(await verify(tx)).map((row) => row.id)).toEqual(['V07']);

      // what a post-Gate-2 migration does (RB-D6): explicit grants for the runtime
      await tx.$executeRawUnsafe('SET LOCAL ROLE migration_owner');
      await tx.$executeRawUnsafe(`GRANT ${DML} ON later_feature TO runtime_app_public`);
      await tx.$executeRawUnsafe('GRANT USAGE, SELECT ON SEQUENCE later_feature_id_seq TO runtime_app_public');
      await tx.$executeRawUnsafe('RESET ROLE');
      expect(failures(await verify(tx))).toEqual([]);
    });
  });

  it('INV-DB2: the runtime never reaches a sig_* object — neither by an explicit grant nor through the default PUBLIC EXECUTE on functions', async () => {
    await inRolledBackTransaction(db, async (tx) => {
      await tx.$executeRawUnsafe('SET LOCAL ROLE migration_owner');
      await tx.$executeRawUnsafe('CREATE TABLE sig_probe_events (id bigserial PRIMARY KEY)');
      await tx.$executeRawUnsafe(`CREATE FUNCTION sig_probe_fn() RETURNS int LANGUAGE sql AS 'SELECT 1'`);
      await tx.$executeRawUnsafe('RESET ROLE');

      // a new function is executable by PUBLIC by default — V09 must flag it
      let failed = failures(await verify(tx));
      expect(failed.map((row) => row.id)).toEqual(['V09']);
      expect(failed[0].detail).toBe('public.sig_probe_fn');

      await tx.$executeRawUnsafe('REVOKE EXECUTE ON FUNCTION sig_probe_fn() FROM PUBLIC');
      expect(failures(await verify(tx))).toEqual([]); // the table was never granted: invisible

      await tx.$executeRawUnsafe('GRANT SELECT ON sig_probe_events TO runtime_app_public');
      failed = failures(await verify(tx));
      expect(failed.map((row) => row.id)).toEqual(['V09']);
      expect(failed[0].detail).toBe('public.sig_probe_events');
    });
  });

  it('RB-D3: only migration_owner and runtime_app_public may connect to the application database; PUBLIC loses postgres/template1', async () => {
    const rows = await db.$queryRawUnsafe<Array<{ grantee: string; can: boolean }>>(
      `SELECT g AS grantee, has_database_privilege(g, current_database(), 'CONNECT') AS can
       FROM unnest($1::text[] || ARRAY['public']) AS g ORDER BY g`,
      [...GATE2_ROLES],
    );
    expect(rows.filter((row) => row.can).map((row) => row.grantee)).toEqual(['migration_owner', 'runtime_app_public']);
    const maintenance = await db.$queryRawUnsafe<Array<{ datname: string; can: boolean }>>(
      `SELECT datname, has_database_privilege('public', oid, 'CONNECT') AS can
       FROM pg_database WHERE datname IN ('postgres', 'template1') ORDER BY datname`,
    );
    expect(maintenance.filter((row) => row.can)).toEqual([]);
  });

  it('Phase A refuses to run a second time', () => {
    const run = executeSqlFile(SQL.phaseA, scratch!.url);
    expect(run.ok).toBe(false);
    expect(run.output).toMatch(/G2-STOP A0: Gate 2 role\(s\) already exist/);
  });

  it('the rollback refuses while a Gate 2 role can still log in', async () => {
    await db.$executeRawUnsafe('ALTER ROLE runtime_app_public LOGIN');
    try {
      const run = executeSqlFile(SQL.rollback, scratch!.url);
      expect(run.ok).toBe(false);
      expect(run.output).toMatch(/G2-STOP R0: role\(s\) still have LOGIN: runtime_app_public/);
    } finally {
      await db.$executeRawUnsafe('ALTER ROLE runtime_app_public NOLOGIN');
    }
    expect(failures(await verify(db))).toEqual([]);
  });

  it('the rollback restores the pre-Phase-A state, after which Phase A applies cleanly again', async () => {
    expect(executeSqlFile(SQL.rollback, scratch!.url)).toMatchObject({ ok: true });
    expect(await existingGate2Roles(db)).toEqual([]);
    expect(await ownersOfApplicationRelations()).toEqual([await currentUser()]);
    const [{ can }] = await db.$queryRawUnsafe<Array<{ can: boolean }>>(
      `SELECT has_database_privilege('public', current_database(), 'CONNECT')
          AND has_database_privilege('public', current_database(), 'TEMPORARY') AS can`,
    );
    expect(can).toBe(true);

    expect(executeSqlFile(SQL.phaseA, scratch!.url)).toMatchObject({ ok: true });
    expect(failures(await verify(db))).toEqual([]);
  });

  it('the R-E4 row-count query runs in a READ ONLY transaction and covers every application table', async () => {
    const rows = await db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY');
      return tx.$queryRawUnsafe<Array<{ table_name: string; row_count: bigint }>>(readFileSync(SQL.rowCounts, 'utf8'));
    });
    const [{ n }] = await db.$queryRawUnsafe<Array<{ n: number }>>(`
      SELECT count(*)::int AS n FROM pg_class c JOIN pg_namespace ns ON ns.oid = c.relnamespace
      WHERE ns.nspname = 'public' AND c.relkind IN ('r', 'p')`);
    expect(rows).toHaveLength(n);
    expect(rows.find((row) => row.table_name === '_prisma_migrations')?.row_count).toBe(BigInt(listMigrations().length));
  });
});
