#!/usr/bin/env bash
# SIG Gate 2 — R-E4 (RUNBOOK.md §8): independent restore check on a DISPOSABLE
# PostgreSQL 18 cluster that exists only for the duration of this script.
#
#   restore-check.sh <dump file> <normalized production counts>
#
# Environment (owner-controlled):
#   R_E4_DIR                           existing directory on owner-controlled ENCRYPTED storage; the
#                                      dump, the counts and the disposable data directory must all be in it
#   R_E4_ENCRYPTED_STORAGE_CONFIRMED   must be "yes": the owner's confirmation that R_E4_DIR is encrypted
#   PG18_BIN                           PostgreSQL 18 binaries (default D:/PostgreSQL/bin); PATH is not used
#   R_E4_PORT                          private port for the disposable server (default 55499)
#
# Steps: initdb (trust, localhost only) → pg_ctl start → createdb restore_check
# → pg_restore --exit-on-error --single-transaction --no-owner --no-privileges
# → 30_rowcounts_readonly.sql (fingerprint-checked against RUNBOOK §6) →
# counts.sh normalize/compare. A trap ALWAYS stops the server and deletes the
# data directory and its log, on success and on failure. Nothing is printed but
# status lines and per-table counts (no row data).
#
# Exit status: 0 counts identical · 2 per-table differences (STOP unless
# explained, RUNBOOK §8) · 1 any other failure (STOP).
set -euo pipefail

die() { echo "G2-STOP R-E4 restore: $*" >&2; exit 1; }
[[ $# -eq 2 ]] || die "usage: restore-check.sh <dump file> <normalized production counts>"

here=$(cd "$(dirname "$0")" && pwd -P)
repo=$(cd "$here/../../.." && pwd -P)
[[ ${R_E4_ENCRYPTED_STORAGE_CONFIRMED:-} == yes ]] || die "set R_E4_ENCRYPTED_STORAGE_CONFIRMED=yes only after confirming R_E4_DIR is on owner-controlled encrypted storage"
[[ -n ${R_E4_DIR:-} && -d ${R_E4_DIR} ]] || die "R_E4_DIR must name an existing directory on encrypted storage"
dir=$(cd "$R_E4_DIR" && pwd -P)
abspath() { echo "$(cd "$(dirname "$1")" && pwd -P)/$(basename "$1")"; }
dump=$(abspath "$1"); prodcounts=$(abspath "$2")
[[ $dump == "$dir"/* && -s $dump ]] || die "the dump must be a non-empty file inside R_E4_DIR"
[[ $prodcounts == "$dir"/* && -s $prodcounts ]] || die "the production counts must be a non-empty file inside R_E4_DIR"

pg=${PG18_BIN:-D:/PostgreSQL/bin}
port=${R_E4_PORT:-55499}
[[ $port =~ ^[0-9]+$ ]] && (( port >= 1024 && port <= 65535 )) || die "R_E4_PORT must be a port number 1024-65535"
version=$("$pg/postgres" --version 2>/dev/null) || die "no PostgreSQL server binaries in PG18_BIN=$pg"
[[ $version =~ \ 18\.[0-9]+ ]] || die "PostgreSQL 18 required, found: $version"

sql30="$repo/db/privileges/30_rowcounts_readonly.sql"
want=$(tr -d '\r' < "$repo/db/privileges/RUNBOOK.md" | grep -E '^\| `30_rowcounts_readonly\.sql` \| `[0-9a-f]{64}` \|$' | grep -oE '[0-9a-f]{64}' || true)
have=$(tr -d '\r' < "$sql30" | sha256sum | cut -c1-64)
[[ -n $want && $have == "$want" ]] || die "30_rowcounts_readonly.sql does not match its RUNBOOK §6 fingerprint"

if "$pg/pg_isready" -h localhost -p "$port" -q < /dev/null; then die "port $port is already serving PostgreSQL; choose another R_E4_PORT"; fi

data="$dir/restore-pgdata-$(date +%Y%m%d%H%M%S)"
log="$data.log"
started=0
cleanup() {
  local code=$? i
  trap - EXIT
  if (( started )); then
    "$pg/pg_ctl" -D "$data" -m fast -w stop > /dev/null 2>&1 < /dev/null \
      || "$pg/pg_ctl" -D "$data" -m immediate -w stop > /dev/null 2>&1 < /dev/null || true
  fi
  for i in 1 2 3 4 5 6 7 8 9 10; do
    rm -rf -- "$data" "$log" "$dir/restore.raw" 2> /dev/null && [[ ! -e $data && ! -e $log ]] && break
    sleep 1
  done
  if [[ -e $data || -e $log ]]; then
    echo "G2-STOP R-E4 restore: cleanup incomplete — delete $data and $log manually" >&2
    exit 1
  fi
  echo "R-E4 restore: cleanup done — disposable server stopped, data directory and log deleted"
  exit "$code"
}
trap cleanup EXIT
trap 'exit 130' INT TERM

echo "R-E4 restore: $version on localhost:$port, data directory inside R_E4_DIR"
"$pg/initdb" -D "$data" -U postgres -A trust -E UTF8 --locale=C > /dev/null 2>&1 < /dev/null || die "initdb failed"
started=1
"$pg/pg_ctl" -D "$data" -o "-p $port -c listen_addresses=localhost" -l "$log" -w start > /dev/null 2>&1 < /dev/null \
  || die "the disposable server did not start"
"$pg/createdb" -h localhost -p "$port" -U postgres restore_check < /dev/null || die "createdb failed"
"$pg/pg_restore" -h localhost -p "$port" -U postgres --exit-on-error --single-transaction --no-owner --no-privileges \
  -d restore_check "$dump" < /dev/null 2> "$dir/restore.err" \
  || die "pg_restore failed (its messages are in R_E4_DIR/restore.err; they may contain data — keep them there)"
rm -f -- "$dir/restore.err"
echo "R-E4 restore: pg_restore completed (single transaction, exit-on-error)"
"$pg/psql" -X -q -At -v ON_ERROR_STOP=1 -h localhost -p "$port" -U postgres -d restore_check -f "$sql30" \
  > "$dir/restore.raw" < /dev/null || die "row counts on the restored copy failed"
"$here/counts.sh" normalize "$dir/restore.raw" "$dir/restore.counts"
set +e
"$here/counts.sh" compare "$prodcounts" "$dir/restore.counts"
result=$?
set -e
exit "$result"
