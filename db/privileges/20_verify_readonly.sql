-- ============================================================================
-- SIG GATE 2 — POST-CHANGE VERIFICATION (READ-ONLY)
--
-- One SELECT returning a row per check: PASS, FAIL or INFO. Run after Phase A
-- and again after Phase D (Phase E). Every non-INFO row must be PASS.
-- Requires the Gate 2 roles to exist (it errors before Phase A).
--
-- Maps to SIG Gate 1 §24.6: G2-C1 ownership · G2-C2 runtime privileges ·
-- G2-C4 privileged attributes (INV-DB1) · INV-DB3 role/membership part ·
-- INV-DB2 / RB-D1 the PUBLIC runtime never reaches a sig_* object (including
-- through PUBLIC's default EXECUTE on functions, so a future sig_* function
-- must REVOKE EXECUTE FROM PUBLIC). G2-C6 (the API connects as
-- runtime_app_public) is V13: INFO here; after Phase D it must list only
-- runtime_app_public (plus this session's role).
--
-- Production (Phase E), read-only:
--   PGOPTIONS='-c default_transaction_read_only=on' \
--     psql -X -v ON_ERROR_STOP=1 -P pager=off -d <application database> \
--     -c 'BEGIN TRANSACTION READ ONLY' -f 20_verify_readonly.sql -c 'ROLLBACK'
-- The CI privilege suite runs this same file (test/db/privilege-boundary.db-spec.ts).
-- ============================================================================
WITH
gate2(rolname) AS (
  VALUES ('migration_owner'), ('runtime_app_public'), ('runtime_app_staff'),
         ('sig_audit_owner'), ('sig_audit_writer'), ('sig_audit_reader'),
         ('sig_context_purger'), ('sig_retention_job'), ('sig_governance_writer'),
         ('sig_anchor_recorder'), ('sig_anchor_publisher')),
no_consumer(rolname) AS (
  SELECT rolname FROM gate2 WHERE rolname NOT IN ('migration_owner', 'runtime_app_public')),
app_rel AS (
  SELECT c.oid, c.relname, c.relkind, c.relowner, c.relacl
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'S')
    AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_class'::regclass AND d.objid = c.oid AND d.deptype = 'e')),
app_fn AS (
  SELECT p.oid, p.proname, p.proowner
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_proc'::regclass AND d.objid = p.oid AND d.deptype = 'e')),
app_typ AS (
  SELECT t.oid, t.typname, t.typowner
  FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
  WHERE n.nspname = 'public' AND t.typtype IN ('e', 'd', 'r')
    AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_type'::regclass AND d.objid = t.oid AND d.deptype = 'e')),
sig_rel AS (
  SELECT c.oid, c.relkind, n.nspname || '.' || c.relname AS name
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE c.relname LIKE 'sig\_%' AND n.nspname NOT IN ('pg_catalog', 'information_schema')),
sig_fn AS (
  SELECT p.oid, n.nspname || '.' || p.proname AS name
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE p.proname LIKE 'sig\_%' AND n.nspname NOT IN ('pg_catalog', 'information_schema')),
runtime_lacks_dml AS (
  SELECT relname FROM app_rel
  WHERE relkind IN ('r', 'p') AND relname <> '_prisma_migrations' AND relname NOT LIKE 'sig\_%'
    AND NOT (has_table_privilege('runtime_app_public', oid, 'SELECT') AND has_table_privilege('runtime_app_public', oid, 'INSERT')
             AND has_table_privilege('runtime_app_public', oid, 'UPDATE') AND has_table_privilege('runtime_app_public', oid, 'DELETE'))
  UNION ALL
  SELECT relname FROM app_rel
  -- CASE, not AND: the planner may evaluate has_sequence_privilege before the
  -- relkind filter, and it errors on anything that is not a sequence
  WHERE relname NOT LIKE 'sig\_%' AND CASE WHEN relkind = 'S' THEN NOT has_sequence_privilege('runtime_app_public', oid, 'USAGE') ELSE false END),
runtime_beyond_dml AS (
  SELECT relname FROM app_rel
  WHERE relkind IN ('r', 'p') AND has_table_privilege('runtime_app_public', oid, 'TRUNCATE, REFERENCES, TRIGGER, MAINTAIN')),
runtime_sig AS (
  SELECT name FROM sig_rel
  WHERE CASE WHEN relkind = 'S' THEN has_sequence_privilege('runtime_app_public', oid, 'USAGE, SELECT, UPDATE')
             ELSE has_table_privilege('runtime_app_public', oid, 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN') END
  UNION ALL
  SELECT name FROM sig_fn WHERE has_function_privilege('runtime_app_public', oid, 'EXECUTE')),
no_consumer_privs AS (
  SELECT DISTINCT pg_get_userbyid(a.grantee) AS rolname
  FROM (SELECT relacl FROM app_rel WHERE relacl IS NOT NULL) r, aclexplode(r.relacl) a
  WHERE pg_get_userbyid(a.grantee) IN (SELECT rolname FROM no_consumer)),
v AS (
  SELECT 'V01' AS id, 'All 11 Gate 2 roles exist' AS title,
         (SELECT count(*) FROM pg_roles r JOIN gate2 g USING (rolname)) = 11 AS ok,
         (SELECT string_agg(g.rolname, ', ') FROM gate2 g WHERE NOT EXISTS (SELECT 1 FROM pg_roles r WHERE r.rolname = g.rolname)) AS detail
  UNION ALL
  SELECT 'V02', 'G2-C4/INV-DB1: no login role except postgres has SUPERUSER/CREATEROLE/CREATEDB/BYPASSRLS/REPLICATION',
         NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolcanlogin AND rolname <> 'postgres' AND rolname NOT LIKE 'pg\_%'
                     AND (rolsuper OR rolcreaterole OR rolcreatedb OR rolbypassrls OR rolreplication)),
         (SELECT string_agg(rolname, ', ') FROM pg_roles WHERE rolcanlogin AND rolname <> 'postgres' AND rolname NOT LIKE 'pg\_%'
                     AND (rolsuper OR rolcreaterole OR rolcreatedb OR rolbypassrls OR rolreplication))
  UNION ALL
  SELECT 'V03', 'Gate 2 roles hold no privileged attribute',
         NOT EXISTS (SELECT 1 FROM pg_roles r JOIN gate2 USING (rolname)
                     WHERE r.rolsuper OR r.rolcreaterole OR r.rolcreatedb OR r.rolbypassrls OR r.rolreplication),
         NULL
  UNION ALL
  SELECT 'V04', 'INV-DB3: Gate 2 roles have no role memberships',
         NOT EXISTS (SELECT 1 FROM pg_auth_members am JOIN pg_roles r ON r.oid = am.roleid JOIN pg_roles m ON m.oid = am.member
                     WHERE r.rolname IN (SELECT rolname FROM gate2) OR m.rolname IN (SELECT rolname FROM gate2)),
         NULL
  UNION ALL
  SELECT 'V05', 'SIG Gate 1 §24.5: the nine roles without a Gate 2 consumer are NOLOGIN',
         NOT EXISTS (SELECT 1 FROM pg_roles r JOIN no_consumer USING (rolname) WHERE r.rolcanlogin),
         (SELECT string_agg(rolname, ', ') FROM pg_roles r JOIN no_consumer USING (rolname) WHERE r.rolcanlogin)
  UNION ALL
  SELECT 'V06', 'G2-C1: every application relation, routine and type is owned by migration_owner',
         NOT EXISTS (SELECT 1 FROM app_rel WHERE relowner <> 'migration_owner'::regrole)
           AND NOT EXISTS (SELECT 1 FROM app_fn WHERE proowner <> 'migration_owner'::regrole)
           AND NOT EXISTS (SELECT 1 FROM app_typ WHERE typowner <> 'migration_owner'::regrole),
         nullif(concat_ws('; ',
           (SELECT string_agg(relname, ', ') FROM app_rel WHERE relowner <> 'migration_owner'::regrole),
           (SELECT string_agg(proname, ', ') FROM app_fn WHERE proowner <> 'migration_owner'::regrole),
           (SELECT string_agg(typname, ', ') FROM app_typ WHERE typowner <> 'migration_owner'::regrole)), '')
  UNION ALL
  SELECT 'V07', 'G2-C2: runtime_app_public has SELECT/INSERT/UPDATE/DELETE on every application table and USAGE on every sequence',
         NOT EXISTS (SELECT 1 FROM runtime_lacks_dml),
         (SELECT string_agg(relname, ', ') FROM runtime_lacks_dml)
  UNION ALL
  SELECT 'V08', 'G2-C2: runtime_app_public has no TRUNCATE/REFERENCES/TRIGGER/MAINTAIN, no schema CREATE, owns nothing, cannot read _prisma_migrations',
         NOT EXISTS (SELECT 1 FROM runtime_beyond_dml)
           AND NOT has_schema_privilege('runtime_app_public', 'public', 'CREATE')
           AND NOT EXISTS (SELECT 1 FROM pg_class WHERE relowner = 'runtime_app_public'::regrole)
           AND NOT EXISTS (SELECT 1 FROM pg_proc WHERE proowner = 'runtime_app_public'::regrole)
           AND NOT EXISTS (SELECT 1 FROM pg_type WHERE typowner = 'runtime_app_public'::regrole)
           AND NOT has_table_privilege('runtime_app_public', 'public._prisma_migrations', 'SELECT, INSERT, UPDATE, DELETE'),
         (SELECT string_agg(relname, ', ') FROM runtime_beyond_dml)
  UNION ALL
  SELECT 'V09', 'INV-DB2/RB-D1: runtime_app_public reaches no sig_* relation, sequence or function, and no default privilege names it',
         NOT EXISTS (SELECT 1 FROM runtime_sig)
           AND NOT EXISTS (SELECT 1 FROM pg_default_acl d, aclexplode(d.defaclacl) a WHERE a.grantee = 'runtime_app_public'::regrole),
         (SELECT string_agg(name, ', ') FROM runtime_sig)
  UNION ALL
  SELECT 'V10', 'The nine roles without a Gate 2 consumer hold no privilege on any application relation',
         NOT EXISTS (SELECT 1 FROM no_consumer_privs),
         (SELECT string_agg(rolname, ', ') FROM no_consumer_privs)
  UNION ALL
  SELECT 'V11', 'RB-D3: PUBLIC and the nine roles cannot CONNECT to this database; PUBLIC cannot CONNECT to postgres/template1',
         NOT has_database_privilege('public', current_database(), 'CONNECT')
           AND NOT EXISTS (SELECT 1 FROM no_consumer WHERE has_database_privilege(rolname, current_database(), 'CONNECT'))
           AND NOT EXISTS (SELECT 1 FROM pg_database WHERE datname IN ('postgres', 'template1') AND has_database_privilege('public', oid, 'CONNECT')),
         NULL
  UNION ALL
  SELECT 'V12', 'Migrations: none unfinished or rolled back',
         NOT EXISTS (SELECT 1 FROM public._prisma_migrations WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL),
         (SELECT count(*)::text || ' applied' FROM public._prisma_migrations))
SELECT id, CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END AS result, title, detail FROM v
UNION ALL
SELECT 'V13', 'INFO', 'G2-C6: connections to this database by role (excluding this session); after Phase D only runtime_app_public may appear for the API',
       (SELECT string_agg(usename || '=' || n, ', ' ORDER BY usename)
          FROM (SELECT usename, count(*) AS n FROM pg_stat_activity
                WHERE datname = current_database() AND pid <> pg_backend_pid() AND usename IS NOT NULL GROUP BY usename) s)
ORDER BY id
