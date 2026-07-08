import { expect, test } from '@playwright/test';

const CLICKHOUSE = process.env.CLICKHOUSE_URL ?? 'http://localhost:8123';
const AUTH = Buffer.from(
  `${process.env.CLICKHOUSE_USER ?? 'default'}:${process.env.CLICKHOUSE_PASSWORD ?? 'unquote-local'}`,
).toString('base64');

async function chQuery(query: string): Promise<string> {
  try {
    const response = await fetch(`${CLICKHOUSE}/?query=${encodeURIComponent(query)}`, {
      headers: { authorization: `Basic ${AUTH}` },
    });
    return response.ok ? (await response.text()).trim() : '';
  } catch {
    return '';
  }
}

let filmId = 0;
let pairA = 0;
let pairB = 0;

test.beforeAll(async () => {
  filmId = Number(
    await chQuery(
      'SELECT movie_id FROM unquote.segments WHERE movie_id IN (SELECT movie_id FROM unquote.five_lines) ORDER BY movie_id LIMIT 1',
    ),
  );
  const pair = await chQuery(
    'SELECT movie_id, similar_id FROM unquote.movie_pairs ORDER BY movie_id, rank LIMIT 1',
  );
  const [a, b] = pair.split('\t').map(Number);
  pairA = a ?? 0;
  pairB = b ?? 0;
});

test.beforeEach(() => {
  test.skip(filmId === 0, 'ladder tables not loaded into ClickHouse');
});

test('a movie page shows five lines and the timeline', async ({ page }, testInfo) => {
  await page.goto(`/movie/${filmId}`);
  await expect(page.locator('h1')).toBeVisible();
  await expect(page.locator('.five-line')).toHaveCount(5);
  const isMobile = testInfo.project.name === 'mobile';
  await expect(page.locator(isMobile ? '.chapter' : '.block').first()).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath(`movie-${testInfo.project.name}.png`),
    fullPage: true,
  });
});

test('the dial switches width without another request', async ({ page }, testInfo) => {
  let neighborCalls = 0;
  await page.route('**/api/movie/*/neighbors*', async (route) => {
    neighborCalls += 1;
    await route.continue();
  });
  await page.goto(`/movie/${filmId}`);
  const isMobile = testInfo.project.name === 'mobile';
  await page
    .locator(isMobile ? '.chapter' : '.block')
    .first()
    .click();
  await expect(page.locator('.dial')).toBeVisible();
  await expect(page.locator('.neighbor').first()).toBeVisible();
  for (const label of ['Exact line', 'Scene', 'Whole movie', 'Exchange']) {
    await page.getByRole('radio', { name: label }).click();
  }
  await expect(page.locator('.panel')).toBeVisible();
  expect(neighborCalls).toBe(1);
});

test('a seq deep link opens the panel on load', async ({ page }) => {
  const seq = await chQuery(
    `SELECT start_seq FROM unquote.segments WHERE movie_id = ${filmId} ORDER BY idx LIMIT 1`,
  );
  await page.goto(`/movie/${filmId}?seq=${seq}`);
  await expect(page.locator('.panel')).toBeVisible();
  await expect(page.locator('.panel')).toHaveAttribute('data-state', 'ready');
  await expect(page.locator('.neighbor').first()).toBeVisible();
});

test('the bridge page lays two films side by side', async ({ page }, testInfo) => {
  test.skip(pairA === 0, 'movie_pairs not loaded');
  await page.goto(`/movie/${pairA}/vs/${pairB}`);
  await expect(page.locator('h1')).toContainText('meets');
  await expect(page.locator('.pair').first()).toBeVisible();
  if (testInfo.project.name === 'desktop') {
    await page.screenshot({ path: testInfo.outputPath('bridge-desktop.png'), fullPage: true });
  }
});

test('an unrelated pair shows the honest empty state', async ({ page }) => {
  test.skip(pairA === 0, 'movie_pairs not loaded');
  // Toy Story and Se7en share a corpus, not moments.
  await page.goto('/movie/862/vs/807');
  await expect(page.locator('.empty')).toContainText('keep their distance');
  await expect(page.locator('.pair')).toHaveCount(0);
});

test('bridge pairs never repeat a moment', async ({ page }) => {
  test.skip(pairA === 0, 'movie_pairs not loaded');
  await page.goto(`/movie/${pairA}/vs/${pairB}`);
  const excerpts = await page.locator('.pair blockquote').allTextContents();
  expect(new Set(excerpts).size).toBe(excerpts.length);
});

test('search results link into the moment', async ({ page }) => {
  await page.goto('/?q=may the force be with you');
  const link = page.locator('.hit .moment').first();
  await expect(link).toBeVisible();
  await expect(link).toHaveAttribute('href', /\/movie\/\d+\?seq=\d+/);
});

test('movie page light theme holds up', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'one engine is enough for the palette');
  await page.addInitScript(() => localStorage.setItem('theme', 'light'));
  await page.goto(`/movie/${filmId}`);
  await expect(page.locator('.five-line').first()).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('movie-light.png'), fullPage: true });
});
