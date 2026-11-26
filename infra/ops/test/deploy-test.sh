#!/usr/bin/env bash
# Exercise caddyfile-changed.sh against throwaway git repos with real commits.
# No SSH, no Docker. Run: infra/ops/test/deploy-test.sh
set -euo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
SCRIPT="$HERE/../caddyfile-changed.sh"
PASS=0
FAIL=0

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
cd "$TMP"
git init -q repo
cd repo
mkdir infra
echo 'a.example.test {}' > infra/Caddyfile
echo one > other.txt
git add -A && git commit -q -m base
base=$(git rev-parse HEAD)

echo two > other.txt
git commit -q -am "other only"
other=$(git rev-parse HEAD)

echo 'b.example.test {}' > infra/Caddyfile
git commit -q -am "caddyfile"
tip=$(git rev-parse HEAD)

expect() { # expect <0|1> <label> <prev>
  set +e
  (cd infra && "$SCRIPT" "$3")
  rc=$?
  set -e
  if [ "$rc" = "$1" ]; then
    echo "  ok: $2"
    PASS=$((PASS + 1))
  else
    echo "  FAIL: $2 (exit $rc, wanted $1)"
    FAIL=$((FAIL + 1))
  fi
}

expect 0 "changed across the Caddyfile commit" "$other"
expect 0 "changed across several commits" "$base"
expect 1 "unchanged when HEAD is the previous commit" "$tip"
git checkout -q "$base"
echo three > other.txt
git commit -q -am "side"
expect 1 "unchanged when only other files differ" "$base"
expect 1 "empty previous commit (fresh box)" ""
expect 1 "unknown previous commit" "0000000000000000000000000000000000000000"

echo "results: $PASS passed, $FAIL failed"
[ "$FAIL" = 0 ]
