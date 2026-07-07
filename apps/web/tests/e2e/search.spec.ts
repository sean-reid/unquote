import { expect, test } from '@playwright/test';

const CLICKHOUSE = process.env.CLICKHOUSE_URL ?? 'http://localhost:8123';
const AUTH = Buffer.from(
  `${process.env.CLICKHOUSE_USER ?? 'default'}:${process.env.CLICKHOUSE_PASSWORD ?? 'unquote-local'}`,
).toString('base64');

let lineCount = 0;

test.beforeAll(async () => {
  try {
    const response = await fetch(
      `${CLICKHOUSE}/?query=${encodeURIComponent('SELECT count() FROM unquote.lines')}`,
      {
        headers: { authorization: `Basic ${AUTH}` },
      },
    );
    lineCount = response.ok ? Number((await response.text()).trim()) : 0;
  } catch {
    lineCount = 0;
  }
});

test.beforeEach(() => {
  test.skip(lineCount === 0, 'slice data not loaded into ClickHouse');
});

test('a famous quote finds its film near the top', async ({ page }, testInfo) => {
  await page.goto('/?q=may the force be with you');
  const titles = page.locator('.hit .meta strong');
  await expect(titles.first()).toBeVisible();
  const topTitles = (await titles.allTextContents()).slice(0, 3).join(' ');
  expect(topTitles).toMatch(/star wars|empire|jedi/i);
  await page.screenshot({ path: testInfo.outputPath('results-dark.png'), fullPage: true });
});

test('apostrophes in the query do not break the keyword arm', async ({ page }) => {
  await page.goto("/?q=you're gonna need a bigger boat");
  const titles = page.locator('.hit .meta strong');
  await expect(titles.first()).toBeVisible();
  const topTitles = (await titles.allTextContents()).slice(0, 3).join(' ');
  expect(topTitles).toMatch(/jaws/i);
});

test('an emptied search box returns to the landing state', async ({ page }) => {
  await page.goto('/?q=may the force be with you');
  await expect(page.locator('.hit').first()).toBeVisible();
  const box = page.getByRole('searchbox', { name: 'Search movie dialogue' });
  await box.fill('');
  await expect(page.locator('.hit')).toHaveCount(0);
  await expect(page.locator('.tagline')).toBeVisible();
});

test('a repeated line collapses to one hit with a count', async ({ page }) => {
  await page.goto('/?q=may the force be with you');
  const exactHits = page
    .locator('.hit', { hasText: 'The Phantom Menace' })
    .filter({ hasText: 'May the Force be with you.' });
  await expect(exactHits).toHaveCount(1);
  await expect(exactHits.first()).toContainText(/said \d+ times/);
});

test('the corpus banner shows on the landing page only', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('.corpus-note')).toBeVisible();
  await expect(page.locator('.corpus-note')).toContainText(/\d+ films/);
  await page.goto('/?q=may the force be with you');
  await expect(page.locator('.corpus-note')).toHaveCount(0);
});

test('a descriptive query still returns moments', async ({ page }) => {
  await page.goto('/?q=a farewell before a long journey');
  await expect(page.locator('.hit').first()).toBeVisible();
});

test('results render server side from the URL alone', async ({ browser }) => {
  const context = await browser.newContext({ javaScriptEnabled: false });
  const page = await context.newPage();
  await page.goto('/?q=i have a bad feeling about this');
  await expect(page.locator('.hit').first()).toBeVisible();
  await context.close();
});

test('light theme results look right', async ({ page }, testInfo) => {
  await page.addInitScript(() => localStorage.setItem('theme', 'light'));
  await page.goto('/?q=may the force be with you');
  await expect(page.locator('.hit').first()).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('results-light.png'), fullPage: true });
});
