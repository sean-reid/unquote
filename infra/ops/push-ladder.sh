#!/usr/bin/env bash
# Ship the context-ladder tables to production: beats, segments, movie_pairs,
# movie_map, five_lines, movie_quality. Native+zstd export, staging tables,
# vector indexes materialized before an atomic swap. The import runs on the
# server under nohup (never trust a laptop pipe with a long mutation), and this
# script polls the server-side log to completion.
#
#   UNQUOTE_HOST=root@<server-ip> infra/ops/push-ladder.sh
set -euo pipefail

: "${UNQUOTE_HOST:?set UNQUOTE_HOST=user@server}"
LOCAL_CH=${LOCAL_CH:-http://localhost:8123}
LOCAL_AUTH=${LOCAL_AUTH:-default:unquote-local}
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

TABLES="beats segments movie_pairs movie_map five_lines movie_quality scene_summaries summary_vectors"

echo "exporting from $LOCAL_CH..."
for t in $TABLES; do
  curl -sf "$LOCAL_CH/" -u "$LOCAL_AUTH" \
    --data "SELECT * FROM unquote.${t} FORMAT Native" | zstd -q -3 -o "$WORK/${t}.native.zst"
  ls -lh "$WORK/${t}.native.zst" | awk '{print "  " $9 ": " $5}'
done

echo "copying to $UNQUOTE_HOST..."
ssh "$UNQUOTE_HOST" 'mkdir -p /tmp/unquote-ladder'
scp -q "$WORK"/*.native.zst "$UNQUOTE_HOST:/tmp/unquote-ladder/"

echo "writing server import script..."
ssh "$UNQUOTE_HOST" 'cat > /root/ladder-import.sh' << 'EOF'
set -euo pipefail
cd /opt/unquote/infra
source .env

chq() {
  docker compose -f docker-compose.prod.yml exec -T clickhouse \
    clickhouse-client --user loader --password "$LOADER_PASSWORD" --database unquote \
    --receive_timeout 3600 --query "$1"
}

VEC768="INDEX vec_idx vec TYPE vector_similarity('hnsw', 'cosineDistance', 768, 'bf16', 16, 128) GRANULARITY 100000000"
BEATS_COLS="movie_id UInt32, idx UInt32, start_seq UInt32, end_seq UInt32, arc Float32, text String, generic Float32, vec Array(Float32)"
SEGMENTS_COLS="movie_id UInt32, idx UInt32, start_beat UInt32, end_beat UInt32, start_seq UInt32, end_seq UInt32, arc Float32, vec Array(Float32)"
PAIRS_COLS="movie_id UInt32, rank UInt8, similar_id UInt32, score Float32"
MAP_COLS="movie_id UInt32, x Float32, y Float32"
FIVE_COLS="movie_id UInt32, seqs Array(UInt32)"
QUALITY_COLS="movie_id UInt32, downrank UInt8, non_english UInt8, source_kind LowCardinality(String)"
SUMMARY_COLS="movie_id UInt32, start_seq UInt32, end_seq UInt32, headline String, summary String"
SUMVEC_COLS="movie_id UInt32, start_seq UInt32, end_seq UInt32, vec Array(Float32)"

make_pair() { # table, cols, order, extra_index
  chq "DROP TABLE IF EXISTS $1_staging"
  chq "CREATE TABLE $1_staging ($2 $4) ENGINE = MergeTree ORDER BY $3" \
    || { echo "create $1_staging failed" >&2; exit 1; }
}
SETTINGS_VEC="SETTINGS allow_experimental_vector_similarity_index = 1"

chq_ddl_vec() {
  docker compose -f docker-compose.prod.yml exec -T clickhouse \
    clickhouse-client --user loader --password "$LOADER_PASSWORD" --database unquote \
    --allow_experimental_vector_similarity_index 1 --receive_timeout 3600 --query "$1"
}

chq "DROP TABLE IF EXISTS beats_staging"
chq_ddl_vec "CREATE TABLE beats_staging ($BEATS_COLS) ENGINE = MergeTree ORDER BY (movie_id, idx)"
chq "DROP TABLE IF EXISTS segments_staging"
chq_ddl_vec "CREATE TABLE segments_staging ($SEGMENTS_COLS) ENGINE = MergeTree ORDER BY (movie_id, idx)"
make_pair movie_pairs "$PAIRS_COLS" "(movie_id, rank)" ""
make_pair movie_map "$MAP_COLS" "movie_id" ""
make_pair five_lines "$FIVE_COLS" "movie_id" ""
make_pair movie_quality "$QUALITY_COLS" "movie_id" ""
make_pair scene_summaries "$SUMMARY_COLS" "(movie_id, start_seq)" ""
make_pair summary_vectors "$SUMVEC_COLS" "(movie_id, start_seq)" ""

for t in beats segments movie_pairs movie_map five_lines movie_quality scene_summaries summary_vectors; do
  echo "inserting $t..."
  zstdcat "/tmp/unquote-ladder/${t}.native.zst" | docker compose -f docker-compose.prod.yml exec -T clickhouse \
    clickhouse-client --user loader --password "$LOADER_PASSWORD" --database unquote \
    --query "INSERT INTO ${t}_staging FORMAT Native"
  n=$(chq "SELECT count() FROM ${t}_staging")
  echo "  $t: $n rows"
  # summary_vectors grows with the generation run and may ship small early.
  [ "$n" -gt 0 ] || [ "$t" = summary_vectors ] || { echo "$t staged empty; aborting" >&2; exit 1; }
done

echo "building beat vector index..."
chq_ddl_vec "ALTER TABLE beats_staging ADD INDEX vec_idx vec TYPE vector_similarity('hnsw', 'cosineDistance', 768, 'bf16', 16, 128) GRANULARITY 100000000"
chq_ddl_vec "ALTER TABLE beats_staging MATERIALIZE INDEX vec_idx SETTINGS mutations_sync = 2"
echo "building segment vector index..."
chq_ddl_vec "ALTER TABLE segments_staging ADD INDEX vec_idx vec TYPE vector_similarity('hnsw', 'cosineDistance', 768, 'bf16', 16, 128) GRANULARITY 100000000"
chq_ddl_vec "ALTER TABLE segments_staging MATERIALIZE INDEX vec_idx SETTINGS mutations_sync = 2"
echo "building summary vector index..."
chq_ddl_vec "ALTER TABLE summary_vectors_staging ADD INDEX vec_idx vec TYPE vector_similarity('hnsw', 'cosineDistance', 768, 'bf16', 16, 128) GRANULARITY 100000000"
chq_ddl_vec "ALTER TABLE summary_vectors_staging MATERIALIZE INDEX vec_idx SETTINGS mutations_sync = 2"

for t in beats segments movie_pairs movie_map five_lines movie_quality scene_summaries summary_vectors; do
  chq "CREATE TABLE IF NOT EXISTS $t AS ${t}_staging"
  chq "EXCHANGE TABLES ${t}_staging AND $t"
  chq "DROP TABLE IF EXISTS ${t}_staging"
done
rm -rf /tmp/unquote-ladder
echo "ladder swap complete"
EOF

echo "launching server-side import..."
# The old log must go first: a launch that dies with the connection would
# otherwise leave the poll matching last run's success line.
ssh "$UNQUOTE_HOST" 'rm -f /root/ladder-import.log && nohup bash /root/ladder-import.sh > /root/ladder-import.log 2>&1 & echo launched'

echo "polling..."
while :; do
  status=$(ssh "$UNQUOTE_HOST" 'grep -E "ladder swap complete|aborting|Exception|error" /root/ladder-import.log 2> /dev/null | tail -1' || true)
  if [ -n "$status" ]; then echo "$status"; break; fi
  sleep 30
done
case "$status" in "ladder swap complete") exit 0 ;; *) exit 1 ;; esac
