#!/usr/bin/env bash
# Take a freshly purchased netcup VPS from checkout to a DNS'd, bootstrapped
# server in one command. Idempotent: every step checks before it acts, so
# rerunning after any failure resumes where things stand.
#
#   infra/ops/provision-netcup.sh              # dry run: print the full plan
#   infra/ops/provision-netcup.sh --execute    # do it
#
# Flags: --execute, --force (overwrite a DNS record pointing elsewhere),
#        --help.
#
# Required environment (put them in the repo .env, which is gitignored):
#   NETCUP_SCP_USER       CCP customer number (the SCP login)
#   NETCUP_SCP_TOKEN      refresh token from SCP top bar > API menu
#   SERVER_ID             netcup server id (the script lists candidates if unset)
#   CLOUDFLARE_API_TOKEN  scoped to Zone > DNS > Edit for dwainosaur.com
# Optional:
#   NETCUP_SCP_PASSWORD   password-grant fallback when no token is set
#   NETCUP_USER_ID        SCP internal user id, if JWT autodetection misses
#   NETCUP_IMAGE_FLAVOUR_ID  exact flavour id when Ubuntu matching is ambiguous
#   NETCUP_OIDC_CLIENT_ID    Keycloak client id (default scp-frontend)
#   NETCUP_API_BASE / NETCUP_TOKEN_URL / CF_API_BASE   test overrides
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
REPO_ROOT=$(cd "$SCRIPT_DIR/../.." && pwd)

API_BASE=${NETCUP_API_BASE:-https://www.servercontrolpanel.de/scp-core/api/v1}
TOKEN_URL=${NETCUP_TOKEN_URL:-https://www.servercontrolpanel.de/realms/scp/protocol/openid-connect/token}
CF_API=${CF_API_BASE:-https://api.cloudflare.com/client/v4}
OIDC_CLIENT_ID=${NETCUP_OIDC_CLIENT_ID:-scp}

ZONE_NAME=dwainosaur.com
RECORD_NAME=unquote.dwainosaur.com
HOSTNAME_TO_SET=unquote
KEY_NAME=unquote-deploy
KEY_FILE="$SCRIPT_DIR/deploy_key"
SETUP_URL=https://raw.githubusercontent.com/sean-reid/unquote/main/infra/ops/setup.sh
TASK_TIMEOUT_SECS=1800
TASK_POLL_SECS=${TASK_POLL_SECS:-10}

MODE=dry-run
FORCE=0
CURRENT_STEP=preflight

usage() { sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'; }

while [ $# -gt 0 ]; do
  case "$1" in
    --execute) MODE=execute ;;
    --dry-run) MODE=dry-run ;;
    --force) FORCE=1 ;;
    --help | -h)
      usage
      exit 0
      ;;
    *)
      echo "unknown flag: $1" >&2
      exit 2
      ;;
  esac
  shift
done

on_err() {
  echo "" >&2
  echo "provision failed during step: $CURRENT_STEP" >&2
  echo "fix the cause and rerun; completed steps will be skipped." >&2
}
trap on_err ERR
trap 'echo ""; echo "interrupted during step: $CURRENT_STEP; rerun to resume." >&2; exit 130' INT

say() { printf '%s\n' "$*"; }
plan() { printf '  PLAN  %s\n' "$*"; }
skip() { printf '  SKIP  %s\n' "$*"; }
did() { printf '  DONE  %s\n' "$*"; }

SUMMARY=""
note_summary() { SUMMARY="${SUMMARY}  $1"$'\n'; }

need() {
  command -v "$1" > /dev/null || {
    echo "missing dependency: $1 ($2)" >&2
    exit 2
  }
}

# --- HTTP helpers -----------------------------------------------------------
# Tokens ride in a curl config on stdin so secrets never appear in argv.
# Retries honor Retry-After on 429/5xx.

ACCESS_TOKEN=""

curl_json() { # curl_json METHOD URL BEARER [JSON_BODY] -> body on stdout, fails loudly
  method=$1 url=$2 bearer=$3 body=${4:-}
  attempt=0
  while :; do
    attempt=$((attempt + 1))
    tmp=$(mktemp)
    hdr=$(mktemp)
    set +e
    if [ -n "$body" ]; then
      status=$(curl -sS -o "$tmp" -D "$hdr" -w '%{http_code}' -X "$method" "$url" \
        -H 'content-type: application/json' --data "$body" \
        --config <(printf 'header = "Authorization: Bearer %s"\n' "$bearer"))
    else
      status=$(curl -sS -o "$tmp" -D "$hdr" -w '%{http_code}' -X "$method" "$url" \
        --config <(printf 'header = "Authorization: Bearer %s"\n' "$bearer"))
    fi
    rc=$?
    set -e
    if [ $rc -ne 0 ]; then
      rm -f "$tmp" "$hdr"
      echo "network error calling $method $url" >&2
      return 7
    fi
    case "$status" in
      2??)
        cat "$tmp"
        rm -f "$tmp" "$hdr"
        return 0
        ;;
      429 | 5??)
        if [ $attempt -ge 4 ]; then
          echo "HTTP $status from $method $url after $attempt attempts:" >&2
          cat "$tmp" >&2
          rm -f "$tmp" "$hdr"
          return 1
        fi
        wait_s=$(tr -d '\r' < "$hdr" | awk -F': ' 'tolower($1)=="retry-after"{print $2}' | head -1)
        [ -n "$wait_s" ] || wait_s=$((attempt * 3))
        say "  transient HTTP $status, retrying in ${wait_s}s..." >&2
        sleep "$wait_s"
        rm -f "$tmp" "$hdr"
        ;;
      *)
        echo "HTTP $status from $method $url:" >&2
        cat "$tmp" >&2
        rm -f "$tmp" "$hdr"
        return 1
        ;;
    esac
  done
}

scp_api() { curl_json "$1" "$API_BASE$2" "$ACCESS_TOKEN" "${3:-}"; }
cf_api() { curl_json "$1" "$CF_API$2" "$CLOUDFLARE_API_TOKEN" "${3:-}"; }

# --- Steps ------------------------------------------------------------------

step_preflight() {
  CURRENT_STEP=preflight
  need jq "brew install jq"
  need curl "comes with macOS"
  need ssh-keygen "comes with macOS"
  if [ -f "$REPO_ROOT/.env" ]; then
    # shellcheck disable=SC1091
    set -a && . "$REPO_ROOT/.env" && set +a
    # Defaults bound at the top of the script predate this load; re-resolve
    # every env-overridable value so .env entries actually take effect.
    API_BASE=${NETCUP_API_BASE:-$API_BASE}
    TOKEN_URL=${NETCUP_TOKEN_URL:-$TOKEN_URL}
    CF_API=${CF_API_BASE:-$CF_API}
    OIDC_CLIENT_ID=${NETCUP_OIDC_CLIENT_ID:-$OIDC_CLIENT_ID}
  fi
  : "${NETCUP_SCP_USER:?set NETCUP_SCP_USER (CCP customer number)}"
  : "${CLOUDFLARE_API_TOKEN:?set CLOUDFLARE_API_TOKEN (Zone > DNS > Edit)}"
  if [ -z "${NETCUP_SCP_TOKEN:-}" ] && [ -z "${NETCUP_SCP_PASSWORD:-}" ]; then
    echo "set NETCUP_SCP_TOKEN (SCP top bar > API menu > create token)" >&2
    echo "or NETCUP_SCP_PASSWORD for the password grant." >&2
    exit 2
  fi
  did "preflight (jq, curl, env present)"
}

step_auth() {
  CURRENT_STEP=auth
  if [ -n "${NETCUP_SCP_TOKEN:-}" ]; then
    grant="grant_type=refresh_token&refresh_token=${NETCUP_SCP_TOKEN}"
  else
    grant="grant_type=password&username=${NETCUP_SCP_USER}&password=${NETCUP_SCP_PASSWORD}"
  fi
  set +e
  resp=$(curl -sS -o /tmp/nc-auth.$$ -w '%{http_code}' -X POST "$TOKEN_URL" \
    -H 'content-type: application/x-www-form-urlencoded' \
    --data "client_id=${OIDC_CLIENT_ID}&${grant}")
  set -e
  if [ "$resp" != "200" ]; then
    echo "authentication with the SCP failed (HTTP $resp)." >&2
    cat /tmp/nc-auth.$$ >&2
    rm -f /tmp/nc-auth.$$
    echo "" >&2
    echo "Most likely the token expired (unused 30 days) or was rolled." >&2
    echo "Mint a fresh one: servercontrolpanel.de > top bar > API > create token," >&2
    echo "then set NETCUP_SCP_TOKEN in .env and rerun." >&2
    exit 1
  fi
  ACCESS_TOKEN=$(jq -r '.access_token' < /tmp/nc-auth.$$)
  rm -f /tmp/nc-auth.$$
  [ -n "$ACCESS_TOKEN" ] && [ "$ACCESS_TOKEN" != null ] || {
    echo "token endpoint answered without access_token" >&2
    exit 1
  }
  did "authenticated with the SCP"
}

jwt_claim() { # jwt_claim TOKEN CLAIM
  payload=$(printf '%s' "$1" | cut -d. -f2 | tr '_-' '/+')
  pad=$(((4 - ${#payload} % 4) % 4))
  i=0
  while [ $i -lt $pad ]; do
    payload="${payload}="
    i=$((i + 1))
  done
  printf '%s' "$payload" | base64 -d 2> /dev/null | jq -r ".${2} // empty"
}

USER_ID=""
step_user() {
  CURRENT_STEP=resolve-user
  USER_ID=${NETCUP_USER_ID:-}
  [ -n "$USER_ID" ] || USER_ID=$(jwt_claim "$ACCESS_TOKEN" sub)
  if [ -z "$USER_ID" ]; then
    echo "could not detect the SCP user id from the token; set NETCUP_USER_ID." >&2
    exit 1
  fi
  if ! scp_api GET "/users/$USER_ID" > /dev/null 2>&1; then
    echo "GET /users/$USER_ID failed. The JWT sub claim may not be the SCP user id;" >&2
    echo "set NETCUP_USER_ID explicitly (visible in SCP account settings) and rerun." >&2
    exit 1
  fi
  did "resolved SCP user id"
}

KEY_ID=""
step_ssh_key() {
  CURRENT_STEP=ssh-key
  if [ ! -f "$KEY_FILE" ]; then
    if [ "$MODE" = dry-run ]; then
      plan "generate ed25519 deploy key at infra/ops/deploy_key"
    else
      ssh-keygen -t ed25519 -N '' -C unquote-deploy -f "$KEY_FILE" > /dev/null
      did "generated deploy key"
    fi
  else
    skip "deploy key exists"
  fi
  if [ ! -f "$KEY_FILE.pub" ]; then
    plan "upload public key as '$KEY_NAME'"
    note_summary "ssh-key: PLAN"
    return 0
  fi
  pub_material=$(awk '{print $2}' "$KEY_FILE.pub")
  existing=$(scp_api GET "/users/$USER_ID/ssh-keys" | jq -r --arg m "$pub_material" \
    '.[] | select((.key | split(" ")[1]) == $m) | .id' | head -1)
  if [ -n "$existing" ]; then
    KEY_ID=$existing
    skip "public key already uploaded (id $KEY_ID)"
    note_summary "ssh-key: SKIPPED (already satisfied)"
    return 0
  fi
  if [ "$MODE" = dry-run ]; then
    plan "POST /users/{userId}/ssh-keys name=$KEY_NAME"
    note_summary "ssh-key: PLAN"
    return 0
  fi
  KEY_ID=$(scp_api POST "/users/$USER_ID/ssh-keys" \
    "$(jq -n --arg n "$KEY_NAME" --arg k "$(cat "$KEY_FILE.pub")" '{name: $n, key: $k}')" | jq -r '.id')
  did "uploaded public key (id $KEY_ID)"
  note_summary "ssh-key: EXECUTED"
}

SERVER_IP=""
step_server() {
  CURRENT_STEP=resolve-server
  if [ -z "${SERVER_ID:-}" ]; then
    echo "SERVER_ID is not set. Your servers:" >&2
    scp_api GET "/servers" | jq -r '.[] | "  id=\(.id)  name=\(.name)  nickname=\(.nickname // "-")"' >&2
    echo "set SERVER_ID in .env and rerun. The script never guesses." >&2
    exit 2
  fi
  server_json=$(scp_api GET "/servers/$SERVER_ID")
  SERVER_IP=$(printf '%s' "$server_json" | jq -r '(.ipv4Addresses[0] // empty) | if type == "object" then .ip else . end')
  say "  server $SERVER_ID: $(printf '%s' "$server_json" | jq -r '"\(.name) host=\(.hostname // "-") nick=\(.nickname // "-")"')"
  [ -n "$SERVER_IP" ] || {
    echo "server has no IPv4 address listed; check the SCP." >&2
    exit 1
  }
  did "server IPv4: $SERVER_IP"
}

ssh_probe() { # true when the box already accepts our deploy key
  [ -f "$KEY_FILE" ] || return 1
  ssh -i "$KEY_FILE" -o BatchMode=yes -o ConnectTimeout=4 \
    -o StrictHostKeyChecking=accept-new "root@$SERVER_IP" true 2> /dev/null
}

step_reinstall() {
  CURRENT_STEP=reinstall
  if ssh_probe; then
    skip "server already accepts the deploy key; reinstall not needed"
    note_summary "reinstall: SKIPPED (already satisfied)"
    return 0
  fi
  running=$(scp_api GET "/tasks" 2> /dev/null |
    jq -r '[.[] | select(.state == "running" or .state == "RUNNING")
            | select(.name | test("image"; "i"))] | first | .uuid // empty' || true)
  if [ -n "$running" ]; then
    say "  found a running image task ($running); resuming its poll instead of reinstalling again"
    [ "$MODE" = dry-run ] && {
      plan "poll task $running to completion"
      note_summary "reinstall: RESUME"
      return 0
    }
    poll_task "$running"
    note_summary "reinstall: RESUMED RUNNING TASK"
    return 0
  fi

  flavours=$(scp_api GET "/servers/$SERVER_ID/imageflavours")
  flavour_id=${NETCUP_IMAGE_FLAVOUR_ID:-}
  if [ -z "$flavour_id" ]; then
    matches=$(printf '%s' "$flavours" | jq '[.[] | select((.name + " " + (.alias // "")) | test("ubuntu"; "i")) | select((.name + " " + (.alias // "")) | test("24\\.04"))]')
    count=$(printf '%s' "$matches" | jq 'length')
    if [ "$count" != "1" ]; then
      echo "Ubuntu 24.04 flavour match was not unique ($count candidates). Available flavours:" >&2
      printf '%s' "$flavours" | jq -r '.[] | "  id=\(.id)  \(.name)  \(.alias // "")"' >&2
      echo "set NETCUP_IMAGE_FLAVOUR_ID to the exact id and rerun." >&2
      exit 2
    fi
    flavour_id=$(printf '%s' "$matches" | jq -r '.[0].id')
    say "  image flavour: $(printf '%s' "$matches" | jq -r '.[0].name') (id $flavour_id)"
  fi

  payload=$(jq -n --argjson f "$flavour_id" --arg h "$HOSTNAME_TO_SET" \
    --argjson k "${KEY_ID:-0}" --arg s "curl -fsSL $SETUP_URL | bash" \
    '{imageFlavourId: $f, hostname: $h, rootPartitionFullDiskSize: true,
      sshKeyIds: [$k], sshPasswordAuthentication: false, customScript: $s}')

  if [ "$MODE" = dry-run ]; then
    plan "POST /servers/$SERVER_ID/image (Ubuntu 24.04, deploy key, setup.sh bootstrap)"
    plan "poll the returned task until done"
    note_summary "reinstall: PLAN"
    return 0
  fi

  say ""
  say "  ABOUT TO WIPE AND REINSTALL server $SERVER_ID ($SERVER_IP)."
  say "  All data on it will be lost. Type the server id to confirm:"
  read -r confirmation
  if [ "$confirmation" != "$SERVER_ID" ]; then
    echo "confirmation mismatch; aborting before any destructive call." >&2
    exit 3
  fi
  task=$(scp_api POST "/servers/$SERVER_ID/image" "$payload" | jq -r '.uuid')
  say "  image task started: $task"
  poll_task "$task"
  note_summary "reinstall: EXECUTED"
}

poll_task() {
  uuid=$1
  waited=0
  while :; do
    state=$(scp_api GET "/tasks/$uuid" | jq -r '.state' | tr '[:upper:]' '[:lower:]')
    case "$state" in
      done | success | finished)
        did "task $uuid finished"
        return 0
        ;;
      failed | error)
        echo "task $uuid FAILED. Inspect it in the SCP, then rerun this script" >&2
        echo "(the rerun resumes automatically; nothing is duplicated)." >&2
        exit 1
        ;;
    esac
    if [ $waited -ge $TASK_TIMEOUT_SECS ]; then
      echo "task $uuid still '$state' after ${TASK_TIMEOUT_SECS}s." >&2
      echo "It may finish on its own; rerun this script later to resume from it." >&2
      exit 1
    fi
    sleep "$TASK_POLL_SECS"
    waited=$((waited + TASK_POLL_SECS))
  done
}

step_dns() {
  CURRENT_STEP=dns
  zone=$(cf_api GET "/zones?name=$ZONE_NAME" | jq -r '.result[0].id // empty')
  if [ -z "$zone" ]; then
    echo "Cloudflare token cannot see zone $ZONE_NAME." >&2
    echo "Note: /user/tokens/verify failing with code 1000 is EXPECTED for scoped" >&2
    echo "tokens; the real test is this zones call. The token needs Zone > DNS > Edit" >&2
    echo "on $ZONE_NAME. Fix the scopes (or the token value) and rerun." >&2
    exit 1
  fi
  record=$(cf_api GET "/zones/$zone/dns_records?type=A&name=$RECORD_NAME")
  rec_id=$(printf '%s' "$record" | jq -r '.result[0].id // empty')
  rec_ip=$(printf '%s' "$record" | jq -r '.result[0].content // empty')
  rec_proxied=$(printf '%s' "$record" | jq -r '.result[0].proxied // empty')
  body=$(jq -n --arg ip "$SERVER_IP" --arg n "$RECORD_NAME" \
    '{type: "A", name: $n, content: $ip, proxied: true, ttl: 1}')

  if [ -n "$rec_id" ] && [ "$rec_ip" = "$SERVER_IP" ] && [ "$rec_proxied" = "true" ]; then
    skip "DNS already correct ($RECORD_NAME -> $SERVER_IP, proxied)"
    note_summary "dns: SKIPPED (already satisfied)"
    return 0
  fi
  if [ -n "$rec_id" ] && [ "$rec_ip" != "$SERVER_IP" ] && [ $FORCE -ne 1 ]; then
    echo "DNS record exists but points elsewhere:" >&2
    echo "  current: $RECORD_NAME -> $rec_ip" >&2
    echo "  wanted:  $RECORD_NAME -> $SERVER_IP" >&2
    echo "rerun with --force to overwrite." >&2
    exit 3
  fi
  if [ "$MODE" = dry-run ]; then
    if [ -n "$rec_id" ]; then
      plan "PUT dns_records/$rec_id -> $SERVER_IP proxied"
    else
      plan "POST dns_records $RECORD_NAME -> $SERVER_IP proxied"
    fi
    note_summary "dns: PLAN"
    return 0
  fi
  if [ -n "$rec_id" ]; then
    cf_api PUT "/zones/$zone/dns_records/$rec_id" "$body" > /dev/null
    did "DNS updated: $RECORD_NAME -> $SERVER_IP (proxied)"
  else
    cf_api POST "/zones/$zone/dns_records" "$body" > /dev/null
    did "DNS created: $RECORD_NAME -> $SERVER_IP (proxied)"
  fi
  note_summary "dns: EXECUTED"
}

step_handoff() {
  CURRENT_STEP=handoff
  say ""
  say "Summary:"
  printf '%s' "$SUMMARY"
  say ""
  say "Remaining, once the reinstall's bootstrap has run (a few minutes):"
  say "  1. ssh -i infra/ops/deploy_key root@$SERVER_IP  # confirm the box is up"
  say "  2. create /opt/unquote/infra/.env from .env.example (openssl rand -hex 24 x3)"
  say "  3. UNQUOTE_HOST=root@$SERVER_IP infra/ops/deploy.sh"
  say "  4. UNQUOTE_HOST=root@$SERVER_IP infra/ops/push-data.sh"
  say "  5. UptimeRobot HTTPS check on https://$RECORD_NAME/"
  say "  6. Cloudflare SSL mode: Full (strict)"
}

say "unquote netcup provision ($MODE mode)"
say ""
step_preflight
step_auth
step_user
step_ssh_key
step_server
step_reinstall
step_dns
step_handoff
