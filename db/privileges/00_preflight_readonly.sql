-- ============================================================================
-- SIG GATE 2 — PREFLIGHT (READ-ONLY)
--
-- The Gate 2 E3 pre-check (P1–P14, run against production 2026-10-05) plus
-- the extra facts Phase A depends on (P15–P18). Re-run it at the start of the
-- maintenance window, before R-E4 and Phase A; its results must match the
-- expectations in RUNBOOK.md, otherwise STOP.
--
-- Read-only by construction: SELECT only, inside a READ ONLY transaction that
-- is rolled back. Run with the server-side read-only default as well:
--   PGOPTIONS='-c default_transaction_read_only=on' \
--     psql -X -v ON_ERROR_STOP=1 -P pager=off -d <application database> -f 00_preflight_readonly.sql
-- Selects no password, hash, token or connection string; archive_command
-- (which can embed credentials) is reported only as a boolean.
-- ============================================================================

BEGIN TRANSACTION READ ONLY;
-- P1 server and database
SELECT current_database() AS db, pg_get_userbyid(d.datdba) AS db_owner, current_setting('server_version') AS server_version FROM pg_database d WHERE d.datname = current_database();
-- P2 role catalog (non-system)
SELECT rolname, rolsuper, rolcreaterole, rolcreatedb, rolcanlogin, rolreplication, rolbypassrls FROM pg_roles WHERE rolname NOT LIKE 'pg\_%' ORDER BY rolname;
-- P3 role memberships involving non-system roles
SELECT r.rolname AS granted_role, m.rolname AS member FROM pg_auth_members am JOIN pg_roles r ON r.oid = am.roleid JOIN pg_roles m ON m.oid = am.member WHERE r.rolname NOT LIKE 'pg\_%' OR m.rolname NOT LIKE 'pg\_%' ORDER BY 1, 2;
-- P4 current connections by role (excluding this session)
SELECT usename, application_name, state, count(*) FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid() GROUP BY 1, 2, 3 ORDER BY 1, 2, 3;
-- P5 schema owners
SELECT nspname, pg_get_userbyid(nspowner) AS owner FROM pg_namespace WHERE nspname NOT LIKE 'pg\_%' AND nspname <> 'information_schema' ORDER BY 1;
-- P6 relation ownership summary in public
SELECT c.relkind, pg_get_userbyid(c.relowner) AS owner, count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind IN ('r','p','S','v','m') GROUP BY 1, 2 ORDER BY 1, 2;
-- P7 sequences in public not owned by a table column
SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind = 'S' AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = c.oid AND d.deptype IN ('a','i')) ORDER BY 1;
-- P8 functions in public: summary, then non-extension functions
SELECT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = p.oid AND d.deptype = 'e') AS from_extension, pg_get_userbyid(p.proowner) AS owner, p.prosecdef, count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' GROUP BY 1, 2, 3 ORDER BY 1, 2, 3;
SELECT p.proname, pg_get_userbyid(p.proowner) AS owner, p.prosecdef FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = p.oid AND d.deptype = 'e') ORDER BY 1;
-- P9 extensions
SELECT extname, extversion, pg_get_userbyid(extowner) AS owner, extnamespace::regnamespace AS schema FROM pg_extension ORDER BY 1;
-- P10 _prisma_migrations
SELECT pg_get_userbyid(c.relowner) AS prisma_migrations_owner FROM pg_class c WHERE c.oid = 'public._prisma_migrations'::regclass;
SELECT count(*) AS applied, max(finished_at) AS last_finished, count(*) FILTER (WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL) AS not_clean FROM public._prisma_migrations;
-- P11 default privileges and public-schema ACL
SELECT pg_get_userbyid(defaclrole) AS role, defaclnamespace::regnamespace AS schema, defaclobjtype, defaclacl FROM pg_default_acl;
SELECT nspname, nspacl FROM pg_namespace WHERE nspname = 'public';
-- P12 RLS, table ACLs, user triggers in public
SELECT count(*) FILTER (WHERE c.relrowsecurity) AS rls_tables, count(*) FILTER (WHERE c.relacl IS NOT NULL) AS tables_with_acl, count(*) AS tables FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind IN ('r','p');
SELECT count(*) AS user_triggers FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND NOT t.tgisinternal;
-- P13 WAL/archive indicators (archive_command reported as boolean only)
SELECT name, CASE WHEN name = 'archive_command' THEN (setting <> '' AND setting <> '(disabled)')::text ELSE setting END AS value FROM pg_settings WHERE name IN ('wal_level','archive_mode','archive_command','archive_timeout') ORDER BY 1;
-- P14 databases in the cluster
SELECT datname, pg_get_userbyid(datdba) AS owner, datallowconn FROM pg_database ORDER BY 1;
-- P15 non-extension types in public by kind and owner (Prisma enums move in Phase A)
SELECT t.typtype, pg_get_userbyid(t.typowner) AS owner, count(*) FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace WHERE n.nspname = 'public' AND t.typtype IN ('e','d','r') AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_type'::regclass AND d.objid = t.oid AND d.deptype = 'e') GROUP BY 1, 2 ORDER BY 1, 2;
-- P16 Gate 2 roles already present (expected: none before Phase A)
SELECT rolname FROM pg_roles WHERE rolname IN ('migration_owner','runtime_app_public','runtime_app_staff','sig_audit_owner','sig_audit_writer','sig_audit_reader','sig_context_purger','sig_retention_job','sig_governance_writer','sig_anchor_recorder','sig_anchor_publisher') ORDER BY 1;
-- P17 SIG objects (expected: none; Gate 3 scope)
SELECT n.nspname, c.relname, c.relkind FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE c.relname LIKE 'sig\_%' AND n.nspname NOT IN ('pg_catalog','information_schema') ORDER BY 1, 2;
-- P18 database ACLs (NULL = PostgreSQL default: PUBLIC may CONNECT and create TEMP tables)
SELECT datname, datacl FROM pg_database ORDER BY 1;
-- P19 statement logging (Phase B: psql \password sends a SCRAM verifier, never the
-- plaintext, but with log_statement = 'ddl'/'all' even the verifier is logged;
-- expected 'none'), password hashing method (expected scram-sha-256)
SELECT name, setting FROM pg_settings WHERE name IN ('log_statement','log_min_duration_statement','log_min_error_statement','password_encryption') ORDER BY 1;
ROLLBACK;
