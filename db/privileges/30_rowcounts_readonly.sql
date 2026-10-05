-- ============================================================================
-- SIG GATE 2 — R-E4 ROW COUNTS (READ-ONLY)
--
-- Exact row count of every application table in schema "public" (including
-- _prisma_migrations). Used by the R-E4 restore verification (RUNBOOK.md): run
-- it on production right after the fresh dump, and on the disposable
-- PostgreSQL 18 copy restored from that dump; the two outputs are compared.
--
-- One SELECT; counts only — no row data, no secrets. query_to_xml runs each
-- count without creating anything, so this works in a READ ONLY transaction:
--   PGOPTIONS='-c default_transaction_read_only=on' \
--     psql -X -v ON_ERROR_STOP=1 -P pager=off -At -d <database> \
--     -c 'BEGIN TRANSACTION READ ONLY' -f 30_rowcounts_readonly.sql -c 'ROLLBACK'
-- ============================================================================
SELECT c.relname AS table_name,
       (xpath('/row/n/text()',
              query_to_xml(format('SELECT count(*) AS n FROM %s', c.oid::regclass), false, true, '')))[1]::text::bigint AS row_count
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
  AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_class'::regclass AND d.objid = c.oid AND d.deptype = 'e')
ORDER BY c.relname
