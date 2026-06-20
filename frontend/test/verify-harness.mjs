import { chromium } from 'playwright';

// runChecks: async (page, ctx) => object.  ctx = { lastSave: ()=>obj }
export async function verify(runChecks, { board = '_verify', viewport = { width: 1600, height: 1000 } } = {}) {
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
  console.log(JSON.stringify(out, null, 2));
  await browser.close();
}
