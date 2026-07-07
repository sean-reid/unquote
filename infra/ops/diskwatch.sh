#!/bin/bash
# Hourly disk check (installed to cron by setup.sh). Past 85% it logs loudly;
# UptimeRobot watches the outside, this watches the inside.
set -euo pipefail

USAGE=$(df --output=pcent / | tail -1 | tr -dc '0-9')
if [ "$USAGE" -ge 85 ]; then
  logger -t unquote-diskwatch "root filesystem at ${USAGE}%"
  touch /var/run/unquote-disk-alert
  # The biggest usual suspects, for whoever ssh'es in to look:
  docker system df 2> /dev/null | logger -t unquote-diskwatch || true
else
  rm -f /var/run/unquote-disk-alert
fi
