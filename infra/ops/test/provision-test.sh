#!/usr/bin/env bash
export UNQUOTE_ENV_FILE=/dev/null
# Exercise provision-netcup.sh against the mock API: the happy path in both
# modes plus three failure paths. No real credentials, no network beyond
# localhost. Run: infra/ops/test/provision-test.sh
set -euo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
SCRIPT="$HERE/../provision-netcup.sh"
PORT=8975
BASE="http://localhost:$PORT"

PASS=0
FAIL=0
MOCK_PID=""

cleanup() { [ -n "$MOCK_PID" ] && kill "$MOCK_PID" 2> /dev/null || true; }
trap cleanup EXIT

start_mock() {
  cleanup
  MOCK_SCENARIO=$1 MOCK_PORT=$PORT MOCK_EXISTING_KEY=${2:-} node "$HERE/mock-api.js" &
  MOCK_PID=$!
  sleep 0.4
}

run_provision() { # run_provision [extra args...] -> output var + exit code in RC
  set +e
  OUT=$(NETCUP_API_BASE="$BASE/api/v1" NETCUP_TOKEN_URL="$BASE/token" CF_API_BASE="$BASE" \
    NETCUP_SCP_USER=9000001 NETCUP_SCP_TOKEN=tok SERVER_ID=5001 \
    CLOUDFLARE_API_TOKEN=cftok TASK_POLL_SECS=1 "$SCRIPT" "$@" 2>&1)
  RC=$?
  set -e
}

expect_rc() { # expect_rc WANT_ZERO(0|1) DESC
  if { [ "$1" = 0 ] && [ $RC -eq 0 ]; } || { [ "$1" = 1 ] && [ $RC -ne 0 ]; }; then
    echo "  ok: $2"
    PASS=$((PASS + 1))
  else
    echo "  FAIL: $2 (exit $RC)"
    printf '%s\n' "$OUT" | sed 's/^/    | /' | tail -20
    FAIL=$((FAIL + 1))
  fi
}

check() { # check DESC PATTERN
  if printf '%s' "$OUT" | grep -q "$2"; then
    echo "  ok: $1"
    PASS=$((PASS + 1))
  else
    echo "  FAIL: $1 (wanted /$2/)"
    printf '%s\n' "$OUT" | sed 's/^/    | /' | tail -20
    FAIL=$((FAIL + 1))
  fi
}

echo "== happy path, dry run"
start_mock happy
run_provision --dry-run
expect_rc 0 "exits 0"
check "plans the reinstall" 'PLAN.*image'
check "plans dns creation" 'PLAN.*POST dns_records'
check "prints handoff" 'UptimeRobot'

echo "== happy path, execute (confirmation piped)"
start_mock happy
set +e
OUT=$(printf '5001\n' | NETCUP_API_BASE="$BASE/api/v1" NETCUP_TOKEN_URL="$BASE/token" CF_API_BASE="$BASE" \
  NETCUP_SCP_USER=9000001 NETCUP_SCP_TOKEN=tok SERVER_ID=5001 \
  CLOUDFLARE_API_TOKEN=cftok TASK_POLL_SECS=1 "$SCRIPT" --execute 2>&1)
RC=$?
set -e
expect_rc 0 "exits 0"
check "task polled to done" 'task task-abc finished'
check "dns created" 'DNS created'
check "summary reports execution" 'reinstall: EXECUTED'

echo "== failure: bad token"
start_mock badtoken
run_provision --dry-run
expect_rc 1 "nonzero exit"
check "actionable message" 'Mint a fresh one'

echo "== idempotency: key already uploaded"
PUB=$(awk '{print $2}' "$HERE/../deploy_key.pub")
start_mock existingkey "$PUB"
run_provision --dry-run
check "key step skipped" 'ssh-key: SKIPPED'

echo "== failure: dns points elsewhere"
start_mock dnsconflict
run_provision --dry-run
expect_rc 1 "nonzero exit"
check "shows both ips" '198.51.100.7'
check "requires force" 'rerun with --force'

echo "== dns conflict resolved with --force"
start_mock dnsconflict
run_provision --dry-run --force
expect_rc 0 "exits 0"
check "plans the overwrite" 'PLAN.*PUT dns_records'

echo ""
echo "results: $PASS passed, $FAIL failed"
[ $FAIL -eq 0 ]
