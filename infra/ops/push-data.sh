#!/bin/bash
# Push the locally built corpus to the server's ClickHouse: export movies and
# lines as zstd-compressed Native, copy them up, load into staging tables, and
# swap atomically. The running app never sees a partial dataset.
#
#   UNQUOTE_HOST=root@<server-ip> infra/ops/push-data.sh
#
# Table DDL below mirrors packages/pipeline/src/stages/load.ts; keep in sync.
set -euo pipefail

: "${UNQUOTE_HOST:?set UNQUOTE_HOST=user@server}"
LOCAL_CH="${LOCAL_CH:-http://localhost:8123}"
LOCAL_AUTH="${CLICKHOUSE_USER:-default}:${CLICKHOUSE_PASSWORD:-unquote-local}"

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

echo "exporting from $LOCAL_CH..."
curl -fsS "$LOCAL_CH" -u "$LOCAL_AUTH" \
  --data 'SELECT * FROM unquote.movies FORMAT Native' | zstd -q > "$WORK/movies.native.zst"
curl -fsS "$LOCAL_CH" -u "$LOCAL_AUTH" \
  --data 'SELECT * FROM unquote.lines FORMAT Native' | zstd -q -3 > "$WORK/lines.native.zst"
ls -lh "$WORK"

echo "copying to $UNQUOTE_HOST..."
ssh "$UNQUOTE_HOST" 'mkdir -p /tmp/unquote-push'
scp -q "$WORK/movies.native.zst" "$WORK/lines.native.zst" "$UNQUOTE_HOST:/tmp/unquote-push/"

echo "loading into staging and swapping..."
ssh "$UNQUOTE_HOST" bash -s << 'EOF'
set -euo pipefail
cd /opt/unquote/infra
source .env

chq() {
  docker compose -f docker-compose.prod.yml exec -T clickhouse \
    clickhouse-client --user loader --password "$LOADER_PASSWORD" --database unquote --query "$1"
}

MOVIES_COLUMNS='
  id UInt32, title String, year UInt16, decade UInt16, rating Float32,
  votes UInt32, poster_path Nullable(String), genre_ids Array(UInt16)'
LINES_COLUMNS='
  movie_id UInt32, seq UInt32, arc Float32, text String, text_norm String,
  vec Array(Float32),
  INDEX idx_text_norm text_norm TYPE tokenbf_v1(32768, 3, 0) GRANULARITY 4'

chq "CREATE TABLE IF NOT EXISTS movies ($MOVIES_COLUMNS) ENGINE = MergeTree ORDER BY id"
chq "CREATE TABLE IF NOT EXISTS lines ($LINES_COLUMNS) ENGINE = MergeTree ORDER BY (movie_id, seq)"
chq "DROP TABLE IF EXISTS movies_staging"
chq "DROP TABLE IF EXISTS lines_staging"
chq "CREATE TABLE movies_staging ($MOVIES_COLUMNS) ENGINE = MergeTree ORDER BY id"
chq "CREATE TABLE lines_staging ($LINES_COLUMNS) ENGINE = MergeTree ORDER BY (movie_id, seq)"

zstdcat /tmp/unquote-push/movies.native.zst | docker compose -f docker-compose.prod.yml exec -T clickhouse \
  clickhouse-client --user loader --password "$LOADER_PASSWORD" --database unquote \
  --query 'INSERT INTO movies_staging FORMAT Native'
zstdcat /tmp/unquote-push/lines.native.zst | docker compose -f docker-compose.prod.yml exec -T clickhouse \
  clickhouse-client --user loader --password "$LOADER_PASSWORD" --database unquote \
  --query 'INSERT INTO lines_staging FORMAT Native'

MOVIES=$(chq 'SELECT count() FROM movies_staging')
LINES=$(chq 'SELECT count() FROM lines_staging')
echo "staged $MOVIES movies, $LINES lines"
if [ "$MOVIES" -eq 0 ] || [ "$LINES" -eq 0 ]; then
  echo "staging looks empty; aborting before the swap" >&2
  exit 1
fi

chq 'EXCHANGE TABLES movies_staging AND movies'
chq 'EXCHANGE TABLES lines_staging AND lines'
chq 'DROP TABLE IF EXISTS movies_staging'
chq 'DROP TABLE IF EXISTS lines_staging'
rm -rf /tmp/unquote-push
echo "swap complete"
EOF
