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
  await expect(page.locator('.block').first()).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath(`movie-${testInfo.project.name}.png`),
    fullPage: true,
  });
});

test('the dial switches width without another request', async ({ page }) => {
  let neighborCalls = 0;
  await page.route('**/api/movie/*/neighbors*', async (route) => {
    neighborCalls += 1;
    await route.continue();
  });
  await page.goto(`/movie/${filmId}`);
  await page.locator('.block').first().click();
  await expect(page.locator('.dial')).toBeVisible();
  await expect(page.locator('.neighbor').first()).toBeVisible();
  for (const label of ['Exact line', 'Scene', 'Whole movie', 'Exchange']) {
    await page.getByRole('radio', { name: label }).click();
  }
  await expect(page.locator('.panel')).toBeVisible();
  expect(neighborCalls).toBe(1);
});

test('the dial never wraps', async ({ page }) => {
  await page.goto(`/movie/${filmId}`);
  await page.locator('.block').first().click();
  await expect(page.locator('.dial')).toBeVisible();
  const tops = await page
    .locator('.dial button')
    .evaluateAll((els) => els.map((el) => el.getBoundingClientRect().top));
  expect(new Set(tops.map((t) => Math.round(t))).size).toBe(1);
});

test('the selected part shows at each width', async ({ page }) => {
  await page.goto(`/movie/${filmId}`);
  await page.locator('.block').first().click();
  await expect(page.locator('.panel')).toHaveAttribute('data-state', 'ready');
  // Exchange is the default width: the part is the whole exchange.
  await expect(page.locator('.this-part .sub-line').first()).toBeVisible();
  await page.getByRole('radio', { name: 'Exact line' }).click();
  await expect(page.locator('.this-part .sub-line')).toHaveCount(1);
  await page.getByRole('radio', { name: 'Scene' }).click();
  const compact = await page.locator('.this-part .sub-line').count();
  const expander = page.locator('.expander');
  if (await expander.count()) {
    await expander.click();
    expect(await page.locator('.this-part .sub-line').count()).toBeGreaterThan(compact);
  }
  await page.getByRole('radio', { name: 'Whole movie' }).click();
  await expect(page.locator('.this-part')).toHaveCount(0);
});

test('the far edge of the strip selects the last part', async ({ page }) => {
  await page.goto(`/movie/${filmId}`);
  const strip = page.locator('.scrubber');
  await expect(strip).toBeVisible();
  const box = (await strip.boundingBox())!;
  const lastIdx = await page.locator('.block').last().getAttribute('data-idx');
  const lastStart = await page.locator('.block').last().getAttribute('data-start');
  const requested: string[] = [];
  await page.route('**/api/movie/*/neighbors*', async (route) => {
    requested.push(route.request().url());
    await route.continue();
  });
  // A press at the strip's right edge must land on the final part, however
  // narrow its block renders.
  await strip.dispatchEvent('pointerdown', { clientX: box.x + box.width - 1, clientY: box.y + 5 });
  await strip.dispatchEvent('pointerup', { clientX: box.x + box.width - 1, clientY: box.y + 5 });
  await strip.dispatchEvent('click', {
    clientX: box.x + box.width - 1,
    clientY: box.y + 5,
    detail: 1,
  });
  await expect(page.locator('.panel')).toHaveAttribute('data-state', 'ready');
  expect(requested[0]).toContain(`segment=${lastIdx}`);
  expect(requested[0]).toContain(`seq=${lastStart}`);
  await expect(page.locator('.block').last()).toHaveAttribute('aria-selected', 'true');
});

test('a middle block resolves to its own part, not its overlapping neighbor', async ({ page }) => {
  await page.goto(`/movie/${filmId}`);
  const blocks = page.locator('.block');
  const count = await blocks.count();
  test.skip(count < 3, 'needs at least three parts');
  const mid = blocks.nth(Math.floor(count / 2));
  const idx = await mid.getAttribute('data-idx');
  const requested: string[] = [];
  await page.route('**/api/movie/*/neighbors*', async (route) => {
    requested.push(route.request().url());
    await route.continue();
  });
  const box = (await mid.boundingBox())!;
  await page.locator('.scrubber').dispatchEvent('pointerdown', {
    clientX: box.x + box.width / 2,
    clientY: box.y + 5,
  });
  await page.locator('.scrubber').dispatchEvent('pointerup', {
    clientX: box.x + box.width / 2,
    clientY: box.y + 5,
  });
  await page.locator('.scrubber').dispatchEvent('click', {
    clientX: box.x + box.width / 2,
    clientY: box.y + 5,
    detail: 1,
  });
  await expect(page.locator('.panel')).toHaveAttribute('data-state', 'ready');
  expect(requested[0]).toContain(`segment=${idx}`);
  await expect(mid).toHaveAttribute('aria-selected', 'true');
});

test('opening in another film shows that film, not the last one', async ({ page }) => {
  const calls: string[] = [];
  await page.route('**/api/movie/*/neighbors*', async (route) => {
    calls.push(route.request().url());
    await route.continue();
  });
  await page.goto(`/movie/${filmId}`);
  await page.locator('.block').first().click();
  await expect(page.locator('.panel')).toHaveAttribute('data-state', 'ready');
  const firstTitle = await page.locator('h1').textContent();
  const firstPart = await page.locator('.this-part').textContent();
  const first = page.locator('.neighbor').first();
  await first.locator('.neighbor-row').click();
  await first.locator('.open-film').click();
  await expect(page).toHaveURL(/\/movie\/\d+\?seq=\d+/);
  await expect(page.locator('h1')).not.toHaveText(firstTitle ?? '');
  await expect(page.locator('.panel')).toHaveAttribute('data-state', 'ready');
  // The panel's subject belongs to the new film's request, not the old state.
  expect(calls.length).toBe(2);
  expect(calls[1]).not.toContain(`/movie/${filmId}/`);
  await expect(page.locator('.this-part')).not.toHaveText(firstPart ?? '');
});

test('a neighbor card previews in place, then opens in the film', async ({ page }) => {
  await page.goto(`/movie/${filmId}`);
  await page.locator('.block').first().click();
  await expect(page.locator('.panel')).toHaveAttribute('data-state', 'ready');
  const url = page.url();
  const first = page.locator('.neighbor').first();
  await first.locator('.neighbor-row').click();
  await expect(first.locator('.neighbor-row')).toHaveAttribute('aria-expanded', 'true');
  await expect(first.locator('.neighbor-more .sub-line').first()).toBeVisible();
  expect(page.url()).toBe(url); // preview does not navigate
  // Only one preview at a time.
  const second = page.locator('.neighbor').nth(1);
  await second.locator('.neighbor-row').click();
  await expect(first.locator('.neighbor-row')).toHaveAttribute('aria-expanded', 'false');
  await expect(second.locator('.neighbor-row')).toHaveAttribute('aria-expanded', 'true');
  // Second tap collapses.
  await second.locator('.neighbor-row').click();
  await expect(second.locator('.neighbor-row')).toHaveAttribute('aria-expanded', 'false');
  // Open in film navigates.
  await first.locator('.neighbor-row').click();
  await first.locator('.open-film').click();
  await expect(page).toHaveURL(/\/movie\/\d+\?seq=\d+/);
});

test('the handle and backdrop dock the sheet instead of destroying it', async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== 'mobile', 'sheet behaviors are mobile only');
  await page.goto(`/movie/${filmId}`);
  await page.locator('.block').first().click();
  await expect(page.locator('.panel')).toHaveAttribute('data-sheet', 'expanded');
  await expect(page.locator('.handle span')).toBeVisible();
  // Real touch tap on the handle: docks, handle stays reachable.
  const handle = (await page.locator('.handle').boundingBox())!;
  await page.touchscreen.tap(handle.x + handle.width / 2, handle.y + 22);
  await expect(page.locator('.panel')).toHaveAttribute('data-sheet', 'docked');
  await expect(page.locator('.handle span')).toBeVisible();
  // Tapping the docked handle expands again, content intact with no refetch.
  await page.waitForTimeout(250); // let the dock transition settle before measuring
  const docked = (await page.locator('.handle').boundingBox())!;
  await page.touchscreen.tap(docked.x + docked.width / 2, docked.y + 22);
  await expect(page.locator('.panel')).toHaveAttribute('data-sheet', 'expanded');
  await expect(page.locator('.this-part')).toBeVisible();
  // The backdrop docks too.
  await page.locator('.backdrop').click({ position: { x: 10, y: 10 } });
  await expect(page.locator('.panel')).toHaveAttribute('data-sheet', 'docked');
});

async function dragHandle(page: import('@playwright/test').Page, dy: number, settle: boolean) {
  await page.locator('.handle').evaluate(
    (el, args) => {
      const box = el.getBoundingClientRect();
      const x = box.x + box.width / 2;
      const y = box.y + 4;
      const fire = (type: string, clientY: number) =>
        el.dispatchEvent(
          new PointerEvent(type, {
            bubbles: true,
            pointerId: 7,
            pointerType: 'touch',
            clientX: x,
            clientY,
          }),
        );
      fire('pointerdown', y);
      for (let step = 1; step <= 4; step++) fire('pointermove', y + (args.dy * step) / 4);
      if (args.settle) fire('pointerup', y + args.dy);
    },
    { dy, settle },
  );
}

test('the sheet comes back from every kind of dock', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'mobile', 'sheet behaviors are mobile only');
  await page.goto(`/movie/${filmId}`);
  const strip = page.locator('.scrubber');
  const openSheet = async () => {
    // Raw taps use viewport coordinates and never auto-scroll; bring the
    // strip on screen and measure it fresh each time.
    await strip.scrollIntoViewIfNeeded();
    const box = (await strip.boundingBox())!;
    await page.touchscreen.tap(box.x + box.width / 2, box.y + 10);
    await expect(page.locator('.panel')).toHaveAttribute('data-sheet', 'expanded');
    await expect(page.locator('.panel')).toHaveAttribute('data-state', 'ready');
  };
  const tapHandle = async () => {
    await page.waitForTimeout(250); // sheet transitions run 150ms; measure settled
    const handle = (await page.locator('.handle').boundingBox())!;
    await page.touchscreen.tap(handle.x + handle.width / 2, handle.y + 22);
  };
  // Dock by handle tap, expand by handle tap.
  await openSheet();
  await tapHandle();
  await expect(page.locator('.panel')).toHaveAttribute('data-sheet', 'docked');
  await tapHandle();
  await expect(page.locator('.panel')).toHaveAttribute('data-sheet', 'expanded');
  // Dock by swipe, expand from the strip.
  await dragHandle(page, 120, true);
  await expect(page.locator('.panel')).toHaveAttribute('data-sheet', 'docked');
  await openSheet();
  // Dock by backdrop, drag the docked handle up to expand.
  await page.locator('.backdrop').click({ position: { x: 10, y: 10 } });
  await expect(page.locator('.panel')).toHaveAttribute('data-sheet', 'docked');
  await page.waitForTimeout(250);
  await dragHandle(page, -80, true);
  await expect(page.locator('.panel')).toHaveAttribute('data-sheet', 'expanded');
});

test('a long drag dismisses the sheet, a short one springs back', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'mobile', 'sheet behaviors are mobile only');
  await page.goto(`/movie/${filmId}`);
  await page.locator('.block').first().click();
  await expect(page.locator('.panel')).toBeVisible();
  // Mid-drag: the sheet follows the finger with the transition disabled.
  await dragHandle(page, 40, false);
  await expect(page.locator('.panel.dragging')).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('sheet-mid-drag.png') });
  await page.locator('.handle').dispatchEvent('pointerup');
  // 40px is under the threshold: it springs back and stays open.
  await expect(page.locator('.panel')).toBeVisible();
  await expect(page.locator('.panel')).not.toHaveClass(/dragging/);
  // 120px crosses the threshold: docked, handle still there.
  await dragHandle(page, 120, true);
  await expect(page.locator('.panel')).toHaveAttribute('data-sheet', 'docked');
  await expect(page.locator('.handle span')).toBeVisible();
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

test('the bridge page draws one ribbon per shared moment', async ({ page }, testInfo) => {
  test.skip(pairA === 0, 'movie_pairs not loaded');
  await page.goto(`/movie/${pairA}/vs/${pairB}`);
  await expect(page.locator('h1')).toContainText('meets');
  await expect(page.locator('.premise')).toContainText('more alike');
  const figure = page.locator('svg[role="img"]');
  await expect(figure).toBeVisible();
  const declared = Number((await figure.getAttribute('aria-label'))?.match(/\d+/)?.[0]);
  await expect(page.locator('.hit')).toHaveCount(declared);
  // The strongest pair's excerpts show by default.
  await expect(page.locator('.sides blockquote')).toHaveCount(2);
  if (testInfo.project.name === 'desktop') {
    await page.screenshot({ path: testInfo.outputPath('bridge-desktop.png'), fullPage: true });
  } else {
    await page.screenshot({ path: testInfo.outputPath('bridge-mobile.png'), fullPage: true });
  }
});

test('the stepper walks the matches and updates the excerpts', async ({ page }) => {
  test.skip(pairA === 0, 'movie_pairs not loaded');
  await page.goto(`/movie/${pairA}/vs/${pairB}`);
  test.skip((await page.locator('.hit').count()) < 2, 'needs at least two shared moments');
  const first = await page.locator('.sides blockquote').first().textContent();
  await page.locator('.step-next').click();
  await expect(page.locator('.stepper span')).toContainText('match 2 of');
  await expect(page.locator('.sides blockquote').first()).not.toHaveText(first ?? '');
  await page.locator('.step-prev').click();
  await expect(page.locator('.stepper span')).toContainText('match 1 of');
  await expect(page.locator('.sides blockquote').first()).toHaveText(first ?? '');
});

test('an unrelated pair shows the honest empty state', async ({ page }) => {
  test.skip(pairA === 0, 'movie_pairs not loaded');
  // Toy Story and Se7en share a corpus, not moments.
  await page.goto('/movie/862/vs/807');
  await expect(page.locator('.empty')).toContainText('keep their distance');
  await expect(page.locator('.hit')).toHaveCount(0);
});

test('bridge pairs never repeat a moment', async ({ page }) => {
  test.skip(pairA === 0, 'movie_pairs not loaded');
  await page.goto(`/movie/${pairA}/vs/${pairB}`);
  const count = await page.locator('.hit').count();
  const seen: string[] = [];
  for (let i = 0; i < count; i++) {
    seen.push(...(await page.locator('.sides blockquote').allTextContents()));
    if (i < count - 1) await page.locator('.step-next').click();
  }
  expect(new Set(seen).size).toBe(seen.length);
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
