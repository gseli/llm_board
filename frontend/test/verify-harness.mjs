import { chromium } from 'playwright';
import { createHash } from 'crypto';
import { readFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const here = dirname(fileURLToPath(import.meta.url));
const boardsDir = resolve(here, '../../boards');

// md5 of a board file on disk, or null if it doesn't exist. Used to fail loudly if a
// verify run mutates the fixture (the _verify.json silent-churn bug: a non-intercepted
// tidyTree→scheduleSave→POST rewrote it across sessions before it was root-caused).
function boardHash(name) {
  const p = resolve(boardsDir, `${name}.json`);
  return existsSync(p) ? createHash('md5').update(readFileSync(p)).digest('hex') : null;
}

// runChecks: async (page, ctx) => object.  ctx = { lastSave: ()=>obj }
export async function verify(runChecks, { board = '_verify', viewport = { width: 1600, height: 1000 } } = {}) {
  const before = boardHash(board);

  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push('console:' + m.text()); });

  await page.route('**/prompt', r =>
    r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ response: 'stub answer.' }) }));
  let lastSave = null;
  await page.route('**/board/**', async (route) => {
    if (route.request().method() === 'POST') { lastSave = route.request().postDataJSON(); return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' }); }
    return route.continue();
  });
  await page.addInitScript((b) => {
    const o = window.fetch;
    window.fetch = (u, x) => { if (typeof u === 'string') u = u.replace('/board/default', '/board/' + b); return o(u, x); };
  }, board);

  await page.goto('http://localhost:8765/', { waitUntil: 'networkidle' });
  await page.waitForTimeout(800);

  const out = await runChecks(page, { lastSave: () => lastSave });
  out.errors = errors;

  // Fail loud if the run wrote to the fixture on disk (every /board POST is stubbed,
  // so the file must be byte-identical afterwards). Folded into errors so the
  // standard `errors.length === 0` acceptance check trips on it too.
  const after = boardHash(board);
  if (before !== after) {
    const msg = `FIXTURE MUTATED ON DISK: boards/${board}.json changed during the run (${before} → ${after})`;
    out.errors.push(msg);
    out.fixtureMutated = true;
    console.error(`\n!!! ${msg}\n`);
  }

  console.log(JSON.stringify(out, null, 2));
  await browser.close();
}
