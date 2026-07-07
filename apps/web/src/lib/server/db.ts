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
});
