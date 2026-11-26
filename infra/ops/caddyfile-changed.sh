#!/bin/bash
# Exit 0 when infra/Caddyfile differs between <previous-commit> and HEAD, 1 when
# it does not. An empty or unknown previous commit exits 1: a fresh box has no
# running Caddy to recreate. Run from anywhere inside the repo.
#   infra/ops/caddyfile-changed.sh <previous-commit>
set -euo pipefail

prev=${1:-}
[ -n "$prev" ] || exit 1
git cat-file -e "$prev^{commit}" 2> /dev/null || exit 1
! git diff --quiet "$prev" HEAD -- :/infra/Caddyfile
