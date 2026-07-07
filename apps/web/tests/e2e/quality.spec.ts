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
      { headers: { authorization: `Basic ${AUTH}` } },
    );
    lineCount = response.ok ? Number((await response.text()).trim()) : 0;
  } catch {
    lineCount = 0;
  }
});

test.beforeEach(() => {
  test.skip(lineCount === 0, 'corpus not loaded into ClickHouse');
});

test('a famous misquote shows the commonly misquoted badge', async ({ page }, testInfo) => {
  await page.goto("/?q=I'll make him an offer he can't refuse");
  const badge = page.locator('.misquote');
  await expect(badge).toBeVisible();
  await expect(badge).toContainText('Commonly misquoted');
  await expect(badge).toContainText("I'm going to make him an offer he can't refuse.");
  await expect(badge.locator('mark').first()).toBeVisible();
  await expect(badge).toContainText('The Godfather');
  await page.screenshot({ path: testInfo.outputPath('misquote-badge.png'), fullPage: false });
});

test('a common phrase shows the phrase card with charts', async ({ page }, testInfo) => {
  await page.goto("/?q=let's get out of here");
  const card = page.locator('.phrase');
  await expect(card).toBeVisible();
  await expect(card).toContainText(/Said in \d+ films/);
  await expect(card).toContainText(/First in/);
  const isMobile = testInfo.project.name === 'mobile';
  if (isMobile) {
    await expect(card).not.toHaveAttribute('open', '');
    await card.locator('summary').click();
  }
  await expect(card.locator('.bars').first()).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('phrase-card.png'), fullPage: false });
});

test('phrase card in light theme', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'one theme screenshot is enough');
  await page.addInitScript(() => localStorage.setItem('theme', 'light'));
  await page.goto("/?q=let's get out of here");
  await expect(page.locator('.phrase')).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('phrase-card-light.png'), fullPage: false });
});
