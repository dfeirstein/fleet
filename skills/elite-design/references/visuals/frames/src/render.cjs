/* Renders each VIDEO-FRAME composite HTML and screenshots the .card element to a
 * crisp PNG. deviceScaleFactor 2 → retina-sharp caption text over the real still.
 * Run from repo root:
 *   NODE_PATH=$HOME/node_modules node skills/elite-design/references/visuals/frames/src/render.cjs
 */
const { chromium } = require('playwright');
const path = require('path');

const SRC = __dirname;                  // .../frames/src
const OUT = path.resolve(SRC, '..');    // .../frames
const PAGES = ['flow-disruption', 'temporal-flow', 'friction',
               'basic-direction', 'layered-paths', 'break-grid'];

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1700, height: 1400 }, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  for (const name of PAGES) {
    await page.goto('file://' + path.join(SRC, name + '.html'), { waitUntil: 'networkidle' });
    await page.evaluate(() => document.fonts.ready.then(() => true));
    await page.waitForTimeout(350);
    const el = await page.$('.card');
    const out = 'frame-' + name + '.png';
    await el.screenshot({ path: path.join(OUT, out) });
    const box = await el.boundingBox();
    console.log('wrote', out, Math.round(box.width) + 'x' + Math.round(box.height));
  }
  await browser.close();
})();
