#!/usr/bin/env bash
# SIG Gate 2 — R-E4 (RUNBOOK.md §8): verify and decode a framed dump stream.
#
#   unframe-dump.sh <framed file> <nonce> <output .dump>
#
# The stream is what `remote-dump.sh` prints through `railway ssh`:
#   [noise]  G2RE4-BEGIN <nonce>
#            <base64 lines, 76 characters each, the last one shorter or padded>
#            G2RE4-COUNT <nonce> <number of base64 lines>
#            G2RE4-END <nonce> pg_dump_exit=<status>
#   [noise]
# Accepted ONLY if exactly that frame is present with this run's nonce, every
# line inside it is strict base64 in the expected shape, the line count matches
# and pg_dump exited 0. Text before BEGIN or after END (for example the
# railway CLI's "Using SSH key …" notice) is counted, never decoded and never
# printed. Anything else inside the frame, a missing or foreign marker, a
# truncated stream or a non-zero pg_dump status fails closed: nothing is
# written to <output .dump>. Carriage returns from a terminal are removed.
#
# Success proves the stream arrived complete and well formed. It does NOT
# prove the dump restores: that is restore-check.sh's job (RUNBOOK §8).
set -euo pipefail

fail() { echo "G2-STOP R-E4 unframe: $*" >&2; rm -f -- "${partial:-}" "${payload:-}"; exit 1; }

[[ $# -eq 3 ]] || fail "usage: unframe-dump.sh <framed file> <nonce> <output .dump>"
framed=$1 nonce=$2 out=$3
[[ $nonce =~ ^[0-9a-f]{16}$ ]] || fail "the nonce must be 16 lowercase hexadecimal characters"
[[ -s $framed ]] || fail "framed file missing or empty: $framed"
[[ ! -e $out ]] || fail "output already exists, refusing to overwrite: $out"
partial="$out.partial"
payload="$out.payload"

# Parse the frame. Exit codes > 0 carry the reason; payload lines go to $payload.
status=0
report=$(tr -d '\r' < "$framed" | awk -v nonce="$nonce" -v payload="$payload" '
  function stop(code, why) { reason = why; failed = code; exit }
  BEGIN { state = 0; n = 0; pre = 0; post = 0; tail = 0 }
  {
    line = $0
    if (state == 0) {
      if (line == "G2RE4-BEGIN " nonce) { state = 1; next }
      if (index(line, "G2RE4-") == 1) stop(10, "a frame marker for another run or out of order before BEGIN")
      pre++; next
    }
    if (state == 1) {
      if (index(line, "G2RE4-COUNT ") == 1) {
        if (line != "G2RE4-COUNT " nonce " " n) stop(11, "line count marker does not match (received " n " base64 lines)")
        state = 2; next
      }
      if (line !~ /^[A-Za-z0-9+\/]+=?=?$/ || length(line) > 76 || length(line) % 4 != 0)
        stop(12, "non-payload line inside the frame after base64 line " n)
      if (tail) stop(13, "base64 line after the final (short or padded) line")
      if (length(line) < 76 || line ~ /=/) tail = 1
      print line > payload; n++; next
    }
    if (state == 2) {
      prefix = "G2RE4-END " nonce " pg_dump_exit="
      if (index(line, prefix) != 1) stop(14, "END marker missing after COUNT")
      code = substr(line, length(prefix) + 1)
      if (code != "0") stop(15, "pg_dump exit status " code)
      state = 3; next
    }
    if (index(line, "G2RE4-") == 1) stop(16, "frame marker after END")
    post++
  }
  END {
    if (failed) { print reason; exit failed }
    if (state != 3) { print (state == 0 ? "BEGIN marker for this nonce not found" : "stream ended before the COUNT/END markers (truncated)"); exit 17 }
    if (n == 0) { print "empty payload"; exit 18 }
    printf "%d %d %d\n", n, pre, post
  }') || status=$?
[[ $status -eq 0 ]] || fail "$report"
read -r lines noise_before noise_after <<< "$report"

base64 -d < "$payload" > "$partial" || fail "base64 decoding failed"
rm -f -- "$payload"
[[ $(head -c 5 "$partial") == PGDMP ]] || fail "decoded data is not a pg_dump custom-format archive"
mv -- "$partial" "$out"

echo "R-E4 unframe: OK — ${lines} base64 lines, $(wc -c < "$out" | tr -d ' ') bytes, sha256 $(sha256sum < "$out" | cut -c1-64)"
echo "R-E4 unframe: lines outside the frame (not decoded): ${noise_before} before BEGIN, ${noise_after} after END"
