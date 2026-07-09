import { createClient } from '@clickhouse/client';

/**
 * Single ClickHouse client for the app. Queries must always go through
 * query_params, never string interpolation.
 */
export const db = createClient({
  url: process.env.CLICKHOUSE_URL ?? 'http://localhost:8123',
  username: process.env.CLICKHOUSE_USER ?? 'default',
  password: process.env.CLICKHOUSE_PASSWORD ?? 'unquote-local',
  database: 'unquote',
  // Nothing the app asks for legitimately runs this long except the first
  // vector query after a swap, which reloads a multi-GB HNSW index from disk;
  // the bound covers that reload once and stops anything slower piling up.
  request_timeout: 25_000,
  clickhouse_settings: { max_execution_time: 20 },
});
