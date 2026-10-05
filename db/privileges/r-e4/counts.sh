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
set -euo pipefail
export LC_ALL=C

ROW='^[a-z_][a-z0-9_]*\|[0-9]+$'
die() { echo "G2-STOP R-E4 counts: $*" >&2; exit 1; }

normalize() {
  local raw=$1 out=$2 dropped
  [[ -s $raw ]] || die "raw counts file missing or empty: $raw"
  if tr -d '\r' < "$raw" | grep -F '|' | grep -vqE "$ROW"; then
    die "malformed table|count row in $raw"
  fi
  tr -d '\r' < "$raw" | grep -E "$ROW" | sort -t '|' -k1,1 > "$out" || true
  [[ -s $out ]] || die "no table|count rows in $raw"
  grep -qE '^_prisma_migrations\|[0-9]+$' "$out" || die "_prisma_migrations missing from $raw"
  [[ -z $(cut -d'|' -f1 "$out" | uniq -d) ]] || die "a table is listed more than once in $raw"
  dropped=$(tr -d '\r' < "$raw" | grep -cvF '|' || true)
  echo "R-E4 counts: $(wc -l < "$out" | tr -d ' ') tables normalized; ${dropped} non-row lines dropped"
}

compare() {
  local prod=$1 restore=$2 f
  for f in "$prod" "$restore"; do
    [[ -s $f ]] || die "normalized counts missing or empty: $f"
    grep -vqE "$ROW" "$f" && die "not a normalized counts file: $f"
  done
  if ! diff <(cut -d'|' -f1 "$prod") <(cut -d'|' -f1 "$restore") > /dev/null; then
    echo "G2-STOP R-E4 counts: the table sets differ (< production, > restore)" >&2
    diff <(cut -d'|' -f1 "$prod") <(cut -d'|' -f1 "$restore") >&2 || true
    exit 1
  fi
  if [[ $(grep '^_prisma_migrations|' "$prod") != "$(grep '^_prisma_migrations|' "$restore")" ]]; then
    echo "G2-STOP R-E4 counts: _prisma_migrations differs ($(grep '^_prisma_migrations|' "$prod") vs $(grep '^_prisma_migrations|' "$restore"))" >&2
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
