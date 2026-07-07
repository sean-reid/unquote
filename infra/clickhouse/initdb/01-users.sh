#!/bin/bash
# Runs once on first container start (empty data dir). Creates the two
# service users: `app` can read everything in unquote and append to the
# analytics tables; `loader` owns the pipeline push path.
set -euo pipefail

ch() {
  clickhouse client --password "$CLICKHOUSE_PASSWORD" --query "$1"
}

: "${APP_PASSWORD:?APP_PASSWORD must be set}"
: "${LOADER_PASSWORD:?LOADER_PASSWORD must be set}"

ch "CREATE DATABASE IF NOT EXISTS unquote"

ch "CREATE USER IF NOT EXISTS app IDENTIFIED BY '${APP_PASSWORD}'"
ch "GRANT SELECT ON unquote.* TO app"
ch "GRANT INSERT ON unquote.search_log TO app"
ch "GRANT INSERT ON unquote.pageviews TO app"

ch "CREATE USER IF NOT EXISTS loader IDENTIFIED BY '${LOADER_PASSWORD}'"
ch "GRANT ALL ON unquote.* TO loader"
