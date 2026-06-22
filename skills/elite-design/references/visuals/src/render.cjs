/* Renders each diagram HTML and screenshots the .frame element to a crisp PNG.
 * deviceScaleFactor 2 → retina-sharp text. Run from repo root:
 *   NODE_PATH=$HOME/node_modules node skills/elite-design/references/visuals/src/render.cjs
 */
const { chromium } = require('playwright');
const path = require('path');

const SRC = __dirname;                  // .../references/visuals/src
const OUT = path.resolve(SRC, '..');    // .../references/visuals
const PAGES = ['type-scale', 'visual-weight-flow', 'friction-good-vs-slop',
               'eye-flow-ladder', 'lift-audit', 'grid-systems', 'proportion'];

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1700, height: 1200 }, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  for (const name of PAGES) {
    await page.goto('file://' + path.join(SRC, name + '.html'), { waitUntil: 'networkidle' });
    await page.evaluate(() => document.fonts.ready.then(() => true));
    await page.waitForTimeout(350);
    const el = await page.$('.frame');
    await el.screenshot({ path: path.join(OUT, name + '.png') });
    const box = await el.boundingBox();
    console.log('wrote', name + '.png', Math.round(box.width) + 'x' + Math.round(box.height));
  }
  await browser.close();
})();
