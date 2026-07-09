#!/bin/bash
# Push the locally built corpus to the server's ClickHouse: export movies and
# lines as zstd-compressed Native, copy them up, load into staging tables, and
# swap atomically. The running app never sees a partial dataset. The import
# runs on the server under nohup (a laptop ssh session dies long before a
# 40-minute insert plus index build finishes) and this script polls the
# server-side log to completion. An upload already sitting on the server at
# the right size is reused instead of copied again.
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
for f in movies.native.zst lines.native.zst; do
  local_size=$(stat -f %z "$WORK/$f" 2> /dev/null || stat -c %s "$WORK/$f")
  remote_size=$(ssh "$UNQUOTE_HOST" "stat -c %s /tmp/unquote-push/$f 2> /dev/null || echo 0")
  if [ "$local_size" = "$remote_size" ]; then
    echo "  $f already on the server at $local_size bytes; reusing"
  else
    scp -q "$WORK/$f" "$UNQUOTE_HOST:/tmp/unquote-push/"
  fi
done

echo "writing server import script..."
ssh "$UNQUOTE_HOST" 'cat > /root/data-import.sh' << 'EOF'
set -euo pipefail
cd /opt/unquote/infra
source .env

chq() {
  docker compose -f docker-compose.prod.yml exec -T clickhouse \
    clickhouse-client --user loader --password "$LOADER_PASSWORD" --database unquote \
    --receive_timeout 3600 --query "$1"
}

MOVIES_COLUMNS='
  id UInt32, title String, year UInt16, decade UInt16, rating Float32,
  votes UInt32, poster_path Nullable(String), genre_ids Array(UInt16)'
LINES_COLUMNS='
  movie_id UInt32, seq UInt32, arc Float32, text String, text_norm String,
  vec Array(Float32),
  INDEX idx_text_norm text_norm TYPE tokenbf_v1(32768, 3, 0) GRANULARITY 4'

chq "CREATE TABLE IF NOT EXISTS movies ($MOVIES_COLUMNS) ENGINE = MergeTree ORDER BY id"
chq "CREATE TABLE IF NOT EXISTS lines ($LINES_COLUMNS) ENGINE = MergeTree ORDER BY (movie_id, seq) SETTINGS index_granularity = 512"

# Analytics tables hold live app writes; created here idempotently (mirroring
# stages/load.ts) and never part of any swap, so pushes cannot clear them.
chq "CREATE TABLE IF NOT EXISTS search_log (
  ts DateTime, query String, query_norm String, hits UInt16, strong UInt16,
  had_movie UInt8, took_ms UInt16, visitor_hash UInt64
) ENGINE = MergeTree ORDER BY ts TTL ts + INTERVAL 180 DAY"
chq "CREATE TABLE IF NOT EXISTS pageviews (
  ts DateTime, path String, referrer String, visitor_hash UInt64
) ENGINE = MergeTree ORDER BY ts TTL ts + INTERVAL 180 DAY"
chq "DROP TABLE IF EXISTS movies_staging"
chq "DROP TABLE IF EXISTS lines_staging"
chq "CREATE TABLE movies_staging ($MOVIES_COLUMNS) ENGINE = MergeTree ORDER BY id"
chq "CREATE TABLE lines_staging ($LINES_COLUMNS) ENGINE = MergeTree ORDER BY (movie_id, seq) SETTINGS index_granularity = 512"

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

echo "building the vector index (the long step)..."
chq "ALTER TABLE lines_staging ADD INDEX vec_idx vec TYPE vector_similarity('hnsw', 'cosineDistance', 384, 'bf16', 16, 128) GRANULARITY 100000000 SETTINGS allow_experimental_vector_similarity_index = 1"
chq "ALTER TABLE lines_staging MATERIALIZE INDEX vec_idx SETTINGS allow_experimental_vector_similarity_index = 1, mutations_sync = 2"

chq 'EXCHANGE TABLES movies_staging AND movies'
chq 'EXCHANGE TABLES lines_staging AND lines'
chq 'DROP TABLE IF EXISTS movies_staging'
chq 'DROP TABLE IF EXISTS lines_staging'
rm -rf /tmp/unquote-push
echo "data swap complete"
EOF

echo "launching server-side import..."
ssh "$UNQUOTE_HOST" 'rm -f /root/data-import.log && nohup bash /root/data-import.sh > /root/data-import.log 2>&1 & echo launched'

echo "polling..."
while :; do
  status=$(ssh "$UNQUOTE_HOST" 'grep -E "data swap complete|aborting|Exception|error" /root/data-import.log | tail -1' || true)
  if [ -n "$status" ]; then echo "$status"; break; fi
  sleep 30
done
case "$status" in "data swap complete") exit 0 ;; *) exit 1 ;; esac
