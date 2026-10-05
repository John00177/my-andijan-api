-- ============================================================================
-- SIG GATE 2 — PHASE A: DATABASE PRIVILEGE BOUNDARY
--
-- Creates the SIG Gate 1 §12 role set (all NOLOGIN, no passwords), moves every
-- application object in schema "public" from the superuser to migration_owner,
-- and grants runtime_app_public explicit DML only. Services keep connecting as
-- the superuser after this file runs, so application behaviour does not change
-- until Phase D (see RUNBOOK.md).
--
-- PRODUCTION: run ONLY inside the owner-authorized maintenance window, after
-- R-E4 (fresh dump + verified isolated restore), by the owner as the database
-- superuser, connected to the APPLICATION database (through the RUNBOOK.md §6
-- transport: production has no public database endpoint):
--   psql -X -v ON_ERROR_STOP=1 -d <application database> -f 10_phase_a_boundary.sql
-- Tests run it through `prisma db execute` (test/db/privileges.ts).
--
-- One transaction. Every failed check RAISEs an exception whose message starts
-- with "G2-STOP", which rolls everything back: the database is left exactly as
-- it was. Contains no password and no connection string, and never may (RB-D4).
--
-- Decisions applied (SIG Gate 2 report §10): RB-D1 explicit grants, NO default
-- privileges · RB-D3 no PUBLIC connect to non-application databases · RB-D5
-- runtime keeps DELETE on application tables (never on sig_* objects) · RB-D7
-- no connection limit (deferred).
-- ============================================================================

BEGIN;

-- Ownership changes take ACCESS EXCLUSIVE locks on each table, held until
-- COMMIT. Fail fast instead of queueing behind (and stalling) live traffic;
-- a lock timeout or deadlock rolls back cleanly and Phase A can be retried.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

-- ---------------------------------------------------------------------------
-- A0 PREFLIGHT — the database must be in the state the Gate 2 pre-check saw.
-- Anything unexpected is a stop condition, not something to work around.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  gate2_roles text[] := ARRAY[
    'migration_owner', 'runtime_app_public', 'runtime_app_staff',
    'sig_audit_owner', 'sig_audit_writer', 'sig_audit_reader',
    'sig_context_purger', 'sig_retention_job', 'sig_governance_writer',
    'sig_anchor_recorder', 'sig_anchor_publisher'];
  bad text;
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    RAISE EXCEPTION 'G2-STOP A0: must run as the database superuser (current_user = %)', current_user;
  END IF;
  IF current_setting('server_version_num')::int < 180000 THEN
    RAISE EXCEPTION 'G2-STOP A0: PostgreSQL 18 required (server_version = %)', current_setting('server_version');
  END IF;
  IF to_regclass('public._prisma_migrations') IS NULL THEN
    RAISE EXCEPTION 'G2-STOP A0: public._prisma_migrations not found — not connected to the application database (%)', current_database();
  END IF;
  IF EXISTS (SELECT 1 FROM public._prisma_migrations WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL) THEN
    RAISE EXCEPTION 'G2-STOP A0: _prisma_migrations has an unfinished or rolled-back migration';
  END IF;

  SELECT string_agg(rolname, ', ') INTO bad FROM pg_roles WHERE rolname = ANY (gate2_roles);
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'G2-STOP A0: Gate 2 role(s) already exist: %', bad;
  END IF;

  -- SIG objects are Gate 3 scope; none may exist yet.
  SELECT string_agg(n.nspname || '.' || c.relname, ', ') INTO bad
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE c.relname LIKE 'sig\_%' AND n.nspname NOT IN ('pg_catalog', 'information_schema');
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'G2-STOP A0: SIG objects already exist (Gate 3 scope): %', bad;
  END IF;

  IF EXISTS (SELECT 1 FROM pg_default_acl) THEN
    RAISE EXCEPTION 'G2-STOP A0: default privileges are defined (expected none)';
  END IF;

  -- Only object kinds the pre-check found are handled below; anything else
  -- (views, materialized views, foreign tables, aggregates…) stops the run.
  SELECT string_agg(c.relname || ' (' || c.relkind::text || ')', ', ') INTO bad
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relkind NOT IN ('r', 'p', 'S', 'i', 'I', 'c', 't')
    AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_class'::regclass AND d.objid = c.oid AND d.deptype = 'e');
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'G2-STOP A0: unexpected relation kinds in public: %', bad;
  END IF;
  SELECT string_agg(p.proname || ' (' || p.prokind::text || ')', ', ') INTO bad
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND (p.prokind NOT IN ('f', 'p') OR p.prosecdef)
    AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_proc'::regclass AND d.objid = p.oid AND d.deptype = 'e');
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'G2-STOP A0: unexpected routines in public (aggregate/window or SECURITY DEFINER): %', bad;
  END IF;

  -- Every application object must still belong to the superuser running this.
  SELECT string_agg(c.relname, ', ') INTO bad
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'S') AND c.relowner <> current_user::regrole
    AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_class'::regclass AND d.objid = c.oid AND d.deptype = 'e');
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'G2-STOP A0: application relations not owned by %: %', current_user, bad;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- A1 ROLES — all NOLOGIN, no password, every privileged attribute denied.
-- Only migration_owner and runtime_app_public ever receive LOGIN, and only in
-- Phase B, by the owner, with psql \password (RB-D4).
-- ---------------------------------------------------------------------------
CREATE ROLE migration_owner       NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT;
CREATE ROLE runtime_app_public    NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT;
CREATE ROLE runtime_app_staff     NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT;
CREATE ROLE sig_audit_owner       NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT;
CREATE ROLE sig_audit_writer      NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT;
CREATE ROLE sig_audit_reader      NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT;
CREATE ROLE sig_context_purger    NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT;
CREATE ROLE sig_retention_job     NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT;
CREATE ROLE sig_governance_writer NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT;
CREATE ROLE sig_anchor_recorder   NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT;
CREATE ROLE sig_anchor_publisher  NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT;

-- ---------------------------------------------------------------------------
-- A2 DATABASE AND SCHEMA ACCESS (RB-D3)
-- PUBLIC loses CONNECT/TEMPORARY on the application database and CONNECT on
-- the maintenance databases; only the two roles that will log in may connect
-- to the application database. Superusers (the platform's own tooling, the
-- break-glass operator) are not subject to these privileges.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  EXECUTE format('REVOKE CONNECT, TEMPORARY ON DATABASE %I FROM PUBLIC', current_database());
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO migration_owner, runtime_app_public', current_database());
  IF current_database() <> 'postgres' AND EXISTS (SELECT 1 FROM pg_database WHERE datname = 'postgres') THEN
    REVOKE CONNECT ON DATABASE postgres FROM PUBLIC;
  END IF;
  REVOKE CONNECT ON DATABASE template1 FROM PUBLIC;
END $$;

GRANT USAGE, CREATE ON SCHEMA public TO migration_owner;
GRANT USAGE ON SCHEMA public TO runtime_app_public;

-- ---------------------------------------------------------------------------
-- A3 OWNERSHIP TRANSFER — application objects only. Extension members
-- (pg_trgm functions, types, operators) stay with the superuser. Sequences
-- owned by a column follow their table automatically; indexes and table row
-- types always follow their table.
-- ---------------------------------------------------------------------------
DO $$
DECLARE r record;
BEGIN
  -- tables (incl. _prisma_migrations, so migration_owner can record migrations)
  FOR r IN
    SELECT c.oid::regclass AS obj FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
      AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_class'::regclass AND d.objid = c.oid AND d.deptype = 'e')
  LOOP
    EXECUTE format('ALTER TABLE %s OWNER TO migration_owner', r.obj);
  END LOOP;
  -- standalone sequences (none today; handled so none is ever left behind)
  FOR r IN
    SELECT c.oid::regclass AS obj FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind = 'S' AND c.relowner <> 'migration_owner'::regrole
      AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_class'::regclass AND d.objid = c.oid AND d.deptype IN ('a', 'i', 'e'))
  LOOP
    EXECUTE format('ALTER SEQUENCE %s OWNER TO migration_owner', r.obj);
  END LOOP;
  -- functions and procedures (the 4 search functions today)
  FOR r IN
    SELECT p.oid::regprocedure AS fn, p.prokind FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_proc'::regclass AND d.objid = p.oid AND d.deptype = 'e')
  LOOP
    EXECUTE format('ALTER %s %s OWNER TO migration_owner', CASE r.prokind WHEN 'p' THEN 'PROCEDURE' ELSE 'FUNCTION' END, r.fn);
  END LOOP;
  -- enum, domain, range and standalone composite types (Prisma enums), so a
  -- later migration can ALTER TYPE … ADD VALUE as migration_owner
  FOR r IN
    SELECT t.oid::regtype AS typ FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE n.nspname = 'public'
      AND (t.typtype IN ('e', 'd', 'r')
           OR (t.typtype = 'c' AND (SELECT c.relkind FROM pg_class c WHERE c.oid = t.typrelid) = 'c'))
      AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_type'::regclass AND d.objid = t.oid AND d.deptype = 'e')
  LOOP
    EXECUTE format('ALTER TYPE %s OWNER TO migration_owner', r.typ);
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- A4 RUNTIME GRANTS (PUBLIC service) — explicit, object by object (RB-D1).
-- DML only: no TRUNCATE, REFERENCES, TRIGGER, MAINTAIN, DDL or ownership.
-- Never on _prisma_migrations and never on a sig_* object. NO default
-- privileges: a table created by a later migration is invisible to the runtime
-- until that migration grants it explicitly (fails closed).
-- ---------------------------------------------------------------------------
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT c.oid::regclass AS obj FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
      AND c.relname <> '_prisma_migrations' AND c.relname NOT LIKE 'sig\_%'
      AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_class'::regclass AND d.objid = c.oid AND d.deptype = 'e')
  LOOP
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE %s TO runtime_app_public', r.obj);
  END LOOP;
  FOR r IN
    SELECT c.oid::regclass AS obj FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind = 'S' AND c.relname NOT LIKE 'sig\_%'
      AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_class'::regclass AND d.objid = c.oid AND d.deptype = 'e')
  LOOP
    EXECUTE format('GRANT USAGE, SELECT ON SEQUENCE %s TO runtime_app_public', r.obj);
  END LOOP;
  -- EXECUTE is also granted to PUBLIC by default; the explicit grant keeps the
  -- runtime working if that default is ever revoked.
  FOR r IN
    SELECT p.oid::regprocedure AS fn FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.prokind = 'f' AND p.proname NOT LIKE 'sig\_%'
      AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_proc'::regclass AND d.objid = p.oid AND d.deptype = 'e')
  LOOP
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO runtime_app_public', r.fn);
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- A5 SELF-CHECK — any failure rolls the whole of Phase A back.
-- (has_table_privilege with a list is true if ANY listed privilege is held.)
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  gate2_roles text[] := ARRAY[
    'migration_owner', 'runtime_app_public', 'runtime_app_staff',
    'sig_audit_owner', 'sig_audit_writer', 'sig_audit_reader',
    'sig_context_purger', 'sig_retention_job', 'sig_governance_writer',
    'sig_anchor_recorder', 'sig_anchor_publisher'];
  bad text;
BEGIN
  -- roles: all present, NOLOGIN, no privileged attribute, no memberships
  IF (SELECT count(*) FROM pg_roles WHERE rolname = ANY (gate2_roles)) <> 11 THEN
    RAISE EXCEPTION 'G2-STOP A5: role set incomplete';
  END IF;
  SELECT string_agg(rolname, ', ') INTO bad FROM pg_roles
  WHERE rolname = ANY (gate2_roles)
    AND (rolcanlogin OR rolsuper OR rolcreaterole OR rolcreatedb OR rolreplication OR rolbypassrls);
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'G2-STOP A5: unexpected role attributes: %', bad;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_auth_members am JOIN pg_roles r ON r.oid = am.roleid JOIN pg_roles m ON m.oid = am.member
             WHERE r.rolname = ANY (gate2_roles) OR m.rolname = ANY (gate2_roles)) THEN
    RAISE EXCEPTION 'G2-STOP A5: Gate 2 roles must have no memberships';
  END IF;

  -- G2-C1: every application object belongs to migration_owner
  SELECT string_agg(c.relname, ', ') INTO bad
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'S') AND c.relowner <> 'migration_owner'::regrole
    AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_class'::regclass AND d.objid = c.oid AND d.deptype = 'e');
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'G2-STOP A5: relations not owned by migration_owner: %', bad;
  END IF;
  SELECT string_agg(p.proname, ', ') INTO bad
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proowner <> 'migration_owner'::regrole
    AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_proc'::regclass AND d.objid = p.oid AND d.deptype = 'e');
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'G2-STOP A5: routines not owned by migration_owner: %', bad;
  END IF;
  SELECT string_agg(t.typname, ', ') INTO bad
  FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
  WHERE n.nspname = 'public' AND t.typtype IN ('e', 'd', 'r') AND t.typowner <> 'migration_owner'::regrole
    AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_type'::regclass AND d.objid = t.oid AND d.deptype = 'e');
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'G2-STOP A5: types not owned by migration_owner: %', bad;
  END IF;

  -- G2-C2: runtime has every DML privilege on every application table…
  SELECT string_agg(c.relname, ', ') INTO bad
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND c.relname <> '_prisma_migrations'
    AND NOT (has_table_privilege('runtime_app_public', c.oid, 'SELECT')
             AND has_table_privilege('runtime_app_public', c.oid, 'INSERT')
             AND has_table_privilege('runtime_app_public', c.oid, 'UPDATE')
             AND has_table_privilege('runtime_app_public', c.oid, 'DELETE'));
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'G2-STOP A5: runtime_app_public lacks DML on: %', bad;
  END IF;
  -- …and nothing beyond DML anywhere
  SELECT string_agg(c.relname, ', ') INTO bad
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
    AND has_table_privilege('runtime_app_public', c.oid, 'TRUNCATE, REFERENCES, TRIGGER, MAINTAIN');
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'G2-STOP A5: runtime_app_public holds TRUNCATE/REFERENCES/TRIGGER/MAINTAIN on: %', bad;
  END IF;
  IF has_table_privilege('runtime_app_public', 'public._prisma_migrations', 'SELECT, INSERT, UPDATE, DELETE') THEN
    RAISE EXCEPTION 'G2-STOP A5: runtime_app_public can access _prisma_migrations';
  END IF;
  IF has_schema_privilege('runtime_app_public', 'public', 'CREATE') THEN
    RAISE EXCEPTION 'G2-STOP A5: runtime_app_public can CREATE in schema public';
  END IF;

  -- The nine roles without a Gate 2 consumer hold no object privilege and
  -- cannot connect to the application database.
  SELECT string_agg(DISTINCT pg_get_userbyid(a.grantee) || ' on ' || c.relname, ', ') INTO bad
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace, aclexplode(c.relacl) a
  WHERE n.nspname = 'public' AND pg_get_userbyid(a.grantee) = ANY (gate2_roles)
    AND pg_get_userbyid(a.grantee) NOT IN ('migration_owner', 'runtime_app_public');
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'G2-STOP A5: STAFF/SIG roles hold object privileges: %', bad;
  END IF;
  SELECT string_agg(rolname, ', ') INTO bad FROM pg_roles
  WHERE rolname = ANY (gate2_roles) AND rolname NOT IN ('migration_owner', 'runtime_app_public')
    AND has_database_privilege(rolname, current_database(), 'CONNECT');
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'G2-STOP A5: roles that must not connect can connect: %', bad;
  END IF;

  -- RB-D1: no default privileges at all
  IF EXISTS (SELECT 1 FROM pg_default_acl) THEN
    RAISE EXCEPTION 'G2-STOP A5: default privileges exist';
  END IF;
END $$;

COMMIT;
