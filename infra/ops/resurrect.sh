#!/bin/bash
# Rebuild the whole site on a fresh box from nothing but this repo and the
# local pipeline artifacts. All server data is derived, so this is the backup
# strategy: provision, deploy, push data.
#
#   UNQUOTE_HOST=root@<new-server-ip> infra/ops/resurrect.sh
set -euo pipefail

: "${UNQUOTE_HOST:?set UNQUOTE_HOST=user@server}"
HERE=$(cd "$(dirname "$0")" && pwd)

ssh "$UNQUOTE_HOST" 'bash -s' < "$HERE/setup.sh"

echo
echo "setup done. Reminder: infra/.env must exist on the server before the stack starts."
echo "If this is a brand new box: ssh in, cp /opt/unquote/infra/.env.example /opt/unquote/infra/.env,"
echo "fill in fresh secrets, then rerun this script or continue below."
read -r -p "press enter when infra/.env is in place..."

"$HERE/deploy.sh"
"$HERE/push-data.sh"
"$HERE/push-ladder.sh"
echo "resurrection complete"
