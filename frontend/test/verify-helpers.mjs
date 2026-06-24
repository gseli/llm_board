// Reusable page-interaction fragments for verify checks, so feature checks compose
// from primitives instead of re-deriving the same Playwright dance each time. Import
// alongside the harness:
//   import { shoot, selectCard, clickCard, fit, labels } from './verify-helpers.mjs';
// Every fragment takes the live `page` the harness already set up.

// Fit everything into view (key "0"), then let fitAll's ease settle — so a later
// click can't miss a card the camera had panned off-screen.
export async function fit(page) {
  await page.keyboard.press("0");
  await page.waitForTimeout(350);
}

// Select a card by id by driving the app's own selectNote — robust, no off-screen
// click flakiness. Use this for "given X is selected" setup; use clickCard only when
// you specifically need to exercise the pointer path.
export async function selectCard(page, id) {
  await page.evaluate((i) => selectNote(i), id);
}

// Click a card by id, fitting first so the camera can't have left it off-canvas
// (Playwright throws "html intercepts pointer events" on an off-screen element).
// Clicks the header (the safe, control-free strip) when present, else the card.
export async function clickCard(page, id) {
  await fit(page);
  const card = page.locator(`.note[data-id="${id}"]`);
  const header = card.locator(".note-header");
  if (await header.count()) await header.first().click();
  else await card.click();
}

// Screenshot the live page (reuses the harness's server + browser). `clip` optional.
// Returns the path so callers can record it in their result object.
export async function shoot(page, { path, clip, fullPage = false } = {}) {
  await page.screenshot({ path, clip, fullPage });
  return path;
}

// Trimmed text of every match — the common "read a list/rows" assertion.
export async function labels(page, selector) {
  return (await page.locator(selector).allTextContents()).map((s) => s.trim());
}
