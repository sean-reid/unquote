import { expect, test } from '@playwright/test';

test('landing page renders the search box', async ({ page }, testInfo) => {
  await page.goto('/');
  await expect(page).toHaveTitle('Unquote');
  const search = page.getByRole('searchbox', { name: 'Search movie dialogue' });
  await expect(search).toBeVisible();
  await search.fill('you talking to me');
  await expect(search).toHaveValue('you talking to me');
  await page.screenshot({
    path: testInfo.outputPath('landing-dark.png'),
    fullPage: true,
  });
});

test('browsing sets no cookies', async ({ page }) => {
  await page.goto('/');
  await page.goto('/?q=hello');
  const cookies = await page.evaluate(() => document.cookie);
  expect(cookies).toBe('');
});

test('light theme applies its palette', async ({ page }, testInfo) => {
  await page.addInitScript(() => localStorage.setItem('theme', 'light'));
  await page.goto('/');
  const background = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  expect(background).toBe('rgb(250, 248, 243)');
  await page.screenshot({
    path: testInfo.outputPath('landing-light.png'),
    fullPage: true,
  });
});
