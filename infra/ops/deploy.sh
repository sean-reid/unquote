#!/bin/bash
# Deploy the current main branch to the server. Run from anywhere:
#   UNQUOTE_HOST=root@<server-ip> infra/ops/deploy.sh
# The server builds the image itself (16GB box, native arch, no registry needed).
set -euo pipefail

: "${UNQUOTE_HOST:?set UNQUOTE_HOST=user@server}"

ssh "$UNQUOTE_HOST" bash -s << 'EOF'
set -euo pipefail
cd /opt/unquote
git fetch origin main
prev=$(git rev-parse --verify -q HEAD || true)
git reset --hard origin/main
echo "deploying $(git rev-parse --short HEAD): $(git log -1 --format=%s)"
cd infra
test -f .env || { echo "infra/.env missing on server; copy .env.example and fill it in" >&2; exit 1; }
docker compose -f docker-compose.prod.yml up -d --build
if ops/caddyfile-changed.sh "$prev"; then
  echo "Caddyfile changed; recreating caddy"
  docker compose -f docker-compose.prod.yml up -d --force-recreate caddy
fi
docker image prune -f
docker compose -f docker-compose.prod.yml ps
EOF
