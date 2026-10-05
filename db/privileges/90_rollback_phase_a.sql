-- ============================================================================
-- SIG GATE 2 — ROLLBACK OF PHASE A
--
-- Returns the application database to its pre-Phase-A state: every object
-- owned by a Gate 2 role goes back to the superuser running this file, every
-- Gate 2 grant is revoked, PUBLIC regains its default CONNECT/TEMPORARY on the
-- application database and CONNECT on postgres/template1, and the eleven Gate 2
-- roles are dropped. (The database ACLs end up explicit rather than NULL, which
-- grants exactly the same privileges.)
--
-- Valid only while NO service uses a Gate 2 role: before Phase B, or after the
-- owner has re-pointed every service back to the previous URL (break-glass,
-- recorded) and set the roles NOLOGIN again. The preflight refuses otherwise.
-- After Gate 3 (once SIG objects exist) this file does not apply.
--
-- PRODUCTION: owner only, as the database superuser, connected to the
-- application database, with explicit authorization (RUNBOOK.md §6 transport):
--   psql -X -v ON_ERROR_STOP=1 -d <application database> -f 90_rollback_phase_a.sql
-- One transaction; any "G2-STOP" exception rolls everything back.
-- ============================================================================

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

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
    RAISE EXCEPTION 'G2-STOP R0: must run as the database superuser (current_user = %)', current_user;
  END IF;
  IF to_regclass('public._prisma_migrations') IS NULL THEN
    RAISE EXCEPTION 'G2-STOP R0: public._prisma_migrations not found — not connected to the application database (%)', current_database();
  END IF;
  IF (SELECT count(*) FROM pg_roles WHERE rolname = ANY (gate2_roles)) <> 11 THEN
    RAISE EXCEPTION 'G2-STOP R0: the Gate 2 role set is not (fully) present — nothing consistent to roll back';
  END IF;
  SELECT string_agg(rolname, ', ') INTO bad FROM pg_roles WHERE rolname = ANY (gate2_roles) AND rolcanlogin;
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'G2-STOP R0: role(s) still have LOGIN: % — re-point services and set NOLOGIN first (RUNBOOK.md, Rollback)', bad;
  END IF;
  SELECT string_agg(DISTINCT usename, ', ') INTO bad FROM pg_stat_activity WHERE usename = ANY (gate2_roles);
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'G2-STOP R0: sessions are connected as: %', bad;
  END IF;
  SELECT string_agg(n.nspname || '.' || c.relname, ', ') INTO bad
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE c.relname LIKE 'sig\_%' AND n.nspname NOT IN ('pg_catalog', 'information_schema');
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'G2-STOP R0: SIG objects exist (%), so this Gate 2 rollback does not apply', bad;
  END IF;
END $$;

-- Ownership back to the operator (the superuser), then every privilege granted
-- to a Gate 2 role in this database and on shared objects (databases) revoked.
REASSIGN OWNED BY migration_owner, runtime_app_public, runtime_app_staff,
  sig_audit_owner, sig_audit_writer, sig_audit_reader, sig_context_purger,
  sig_retention_job, sig_governance_writer, sig_anchor_recorder, sig_anchor_publisher
  TO CURRENT_USER;
DROP OWNED BY migration_owner, runtime_app_public, runtime_app_staff,
  sig_audit_owner, sig_audit_writer, sig_audit_reader, sig_context_purger,
  sig_retention_job, sig_governance_writer, sig_anchor_recorder, sig_anchor_publisher;

DO $$
BEGIN
  EXECUTE format('GRANT CONNECT, TEMPORARY ON DATABASE %I TO PUBLIC', current_database());
  IF current_database() <> 'postgres' AND EXISTS (SELECT 1 FROM pg_database WHERE datname = 'postgres') THEN
    GRANT CONNECT ON DATABASE postgres TO PUBLIC;
  END IF;
  GRANT CONNECT ON DATABASE template1 TO PUBLIC;
END $$;

DROP ROLE migration_owner, runtime_app_public, runtime_app_staff,
  sig_audit_owner, sig_audit_writer, sig_audit_reader, sig_context_purger,
  sig_retention_job, sig_governance_writer, sig_anchor_recorder, sig_anchor_publisher;

DO $$
DECLARE bad text;
BEGIN
  SELECT string_agg(c.relname, ', ') INTO bad
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'S') AND c.relowner <> current_user::regrole
    AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_class'::regclass AND d.objid = c.oid AND d.deptype = 'e');
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'G2-STOP R1: relations not returned to %: %', current_user, bad;
  END IF;
  IF NOT has_database_privilege('public', current_database(), 'CONNECT')
     OR NOT has_database_privilege('public', current_database(), 'TEMPORARY') THEN
    RAISE EXCEPTION 'G2-STOP R1: PUBLIC CONNECT/TEMPORARY on the application database not restored';
  END IF;
END $$;

COMMIT;
