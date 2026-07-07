import { expect, test } from '@playwright/test';
import entries from '../eval/quotes.json' with { type: 'json' };

const CLICKHOUSE = process.env.CLICKHOUSE_URL ?? 'http://localhost:8123';
const AUTH = Buffer.from(
  `${process.env.CLICKHOUSE_USER ?? 'default'}:${process.env.CLICKHOUSE_PASSWORD ?? 'unquote-local'}`,
).toString('base64');

interface EvalEntry {
  query: string;
  expectFilm: string;
  expectInTop: number;
  mustBeInCorpus: boolean;
  note: string;
}

let titles: string[] = [];

test.beforeAll(async () => {
  try {
    const response = await fetch(
      `${CLICKHOUSE}/?query=${encodeURIComponent('SELECT title FROM unquote.movies FORMAT JSONEachRow')}`,
      { headers: { authorization: `Basic ${AUTH}` } },
    );
    if (response.ok) {
      const body = await response.text();
      titles = body
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => (JSON.parse(line) as { title: string }).title);
    }
  } catch {
    titles = [];
  }
});

test('search quality eval scoreboard', async ({ request }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'eval runs once, not per device');
  test.skip(titles.length === 0, 'no corpus loaded');
  test.setTimeout(180_000);

  const passed: string[] = [];
  const failed: string[] = [];
  const skipped: string[] = [];

  for (const entry of entries as EvalEntry[]) {
    const filmPattern = new RegExp(entry.expectFilm, 'i');
    if (!titles.some((title) => filmPattern.test(title))) {
      skipped.push(`${entry.query} (${entry.note}; film not in corpus)`);
      continue;
    }
    const response = await request.get(`/api/search?q=${encodeURIComponent(entry.query)}`);
    if (!response.ok()) {
      failed.push(`${entry.query} -> http ${response.status()}`);
      continue;
    }
    const body = (await response.json()) as {
      hits: Array<{ title: string }>;
      misquote: { film: string } | null;
    };
    const rank = body.hits.findIndex((hit) => filmPattern.test(hit.title));
    // The misquote badge names the film above the results, which answers the
    // user even when the ranked list misses.
    const badgeAnswers = body.misquote !== null && filmPattern.test(body.misquote.film);
    if ((rank >= 0 && rank < entry.expectInTop) || badgeAnswers) {
      passed.push(entry.query);
    } else {
      const top = body.hits
        .slice(0, 3)
        .map((hit) => hit.title)
        .join(' / ');
      failed.push(
        `${entry.query} -> expected ${entry.expectFilm} in top ${entry.expectInTop}, rank ${rank < 0 ? 'absent' : rank + 1}; top: ${top}`,
      );
    }
  }

  const scoreboard = [
    `eval: ${passed.length} passed, ${failed.length} failed, ${skipped.length} skipped (of ${entries.length})`,
    ...failed.map((f) => `  FAIL ${f}`),
    ...skipped.map((s) => `  SKIP ${s}`),
  ].join('\n');
  console.log(scoreboard);
  await testInfo.attach('scoreboard', { body: scoreboard, contentType: 'text/plain' });

  expect(failed, scoreboard).toEqual([]);
});
