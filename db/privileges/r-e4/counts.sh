#!/usr/bin/env bash
# SIG Gate 2 — R-E4 (RUNBOOK.md §8): row-count artifacts in one deterministic format.
#
#   counts.sh normalize <raw psql output> <normalized file>
#   counts.sh compare   <normalized production> <normalized restore>
#
# normalize keeps exactly the `table|count` rows of 30_rowcounts_readonly.sql
# (unaligned, tuples-only psql output), sorted bytewise by table name. Lines
# without a `|` (psql command tags such as BEGIN/ROLLBACK, warnings, the
# railway CLI's notice) are dropped and counted. A line WITH a `|` that is not
# a well-formed `table|count` row fails closed, as does a result without
# `_prisma_migrations` or with a table listed twice.
#
# compare exit status:
#   0  identical
#   1  STOP: different table sets, a different _prisma_migrations count, or a
#      malformed/missing file
#   2  STOP unless explained: only per-table counts differ. RUNBOOK §8 allows
#      such a difference only for a table written to between the dump and the
#      production count, explained and recorded; otherwise repeat R-E4.
#
# Every check reads its WHOLE input and has its exit status checked on its own:
# no early-exit consumer (grep -q, head, …) sits downstream of a pipe. Under
# `pipefail` such a consumer once let a malformed row through on large inputs —
# the producer died of SIGPIPE (141), which the `if` took for "no match". A
# grep exit status of 1 ("no match") is accepted only where it means that; 2 or
# higher (a real failure) always stops.
set -euo pipefail
export LC_ALL=C

ROW='^[a-z_][a-z0-9_]*\|[0-9]+$'
die() { echo "G2-STOP R-E4 counts: $*" >&2; exit 1; }

TMPFILES=()
trap 'if (( ${#TMPFILES[@]} )); then rm -f -- "${TMPFILES[@]}"; fi' EXIT
# Name for a temp file next to $1 (inside R_E4_DIR). Runs in $( … ), a subshell,
# so the caller registers it: x=$(tmpfile …); TMPFILES+=("$x").
tmpfile() { echo "$1.tmp.$$.${#TMPFILES[@]}"; }

normalize() {
  local raw=$1 out=$2 clean rows bad dup dropped rc
  [[ -s $raw && -r $raw ]] || die "raw counts file missing, empty or unreadable: $raw"
  clean=$(tmpfile "$out"); TMPFILES+=("$clean")
  rows=$(tmpfile "$out"); TMPFILES+=("$rows")
  tr -d '\r' < "$raw" > "$clean" || die "could not read $raw"
  # One pass over the whole input; counts every line with a `|` that is not a well-formed row.
  bad=$(awk 'index($0, "|") && $0 !~ /^[a-z_][a-z0-9_]*[|][0-9]+$/ { n++ } END { print n + 0 }' "$clean") \
    || die "could not validate $raw"
  [[ $bad == 0 ]] || die "malformed table|count row in $raw ($bad line(s))"
  rc=0; grep -E "$ROW" "$clean" > "$rows" || rc=$?
  (( rc <= 1 )) || die "could not extract the rows of $raw (grep exit $rc)"
  [[ -s $rows ]] || die "no table|count rows in $raw"
  sort -t '|' -k1,1 "$rows" > "$out" || die "could not sort the rows of $raw"
  rc=0; grep -qE '^_prisma_migrations\|[0-9]+$' "$out" || rc=$?
  (( rc == 0 )) || die "_prisma_migrations missing from $raw"
  dup=$(awk -F'|' 'seen[$1]++ { print $1 }' "$out") || die "could not check $raw for duplicate tables"
  [[ -z $dup ]] || die "a table is listed more than once in $raw: ${dup//$'\n'/, }"
  rc=0; dropped=$(grep -cvF '|' "$clean") || rc=$?
  (( rc <= 1 )) || die "could not count the non-row lines of $raw (grep exit $rc)"
  echo "R-E4 counts: $(wc -l < "$out" | tr -d ' ') tables normalized; ${dropped} non-row lines dropped"
}

compare() {
  local prod=$1 restore=$2 f rc pk rk pmig rmig
  for f in "$prod" "$restore"; do
    [[ -s $f && -r $f ]] || die "normalized counts missing, empty or unreadable: $f"
    rc=0; grep -vqE "$ROW" "$f" || rc=$?   # reads a file, not a pipe: no SIGPIPE
    case $rc in
      0) die "not a normalized counts file: $f" ;;
      1) ;;
      *) die "could not read $f (grep exit $rc)" ;;
    esac
  done
  pk=$(tmpfile "$prod"); TMPFILES+=("$pk")
  rk=$(tmpfile "$restore"); TMPFILES+=("$rk")
  cut -d'|' -f1 "$prod" > "$pk" || die "could not read $prod"
  cut -d'|' -f1 "$restore" > "$rk" || die "could not read $restore"
  if ! cmp -s "$pk" "$rk"; then
    echo "G2-STOP R-E4 counts: the table sets differ (< production, > restore)" >&2
    diff "$pk" "$rk" >&2 || true   # display only; the decision is already STOP
    exit 1
  fi
  pmig=$(grep '^_prisma_migrations|' "$prod") || die "_prisma_migrations missing from $prod"
  rmig=$(grep '^_prisma_migrations|' "$restore") || die "_prisma_migrations missing from $restore"
  if [[ $pmig != "$rmig" ]]; then
    echo "G2-STOP R-E4 counts: _prisma_migrations differs ($pmig vs $rmig)" >&2
    exit 1
  fi
  if cmp -s "$prod" "$restore"; then
    echo "R-E4 counts: MATCH ($(wc -l < "$prod" | tr -d ' ') tables; _prisma_migrations and every table identical)"
    return 0
  fi
  echo "R-E4 counts: DIFFERENCES (production vs restore) — STOP unless each is explained and recorded (RUNBOOK §8):" >&2
  join -t '|' "$prod" "$restore" | awk -F'|' '$2 != $3 { print "  " $1 ": " $2 " vs " $3 }' >&2
  exit 2
}

case ${1:-} in
  normalize) [[ $# -eq 3 ]] || die "usage: counts.sh normalize <raw> <out>"; normalize "$2" "$3" ;;
  compare)   [[ $# -eq 3 ]] || die "usage: counts.sh compare <production> <restore>"; compare "$2" "$3" ;;
  *) die "usage: counts.sh normalize <raw> <out> | compare <production> <restore>" ;;
esac
