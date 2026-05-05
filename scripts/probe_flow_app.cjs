// Open a fresh tab, navigate to /fx/tools/flow, wait 8s, dump everything visible.
'use strict';
const puppeteer = require('puppeteer');

(async () => {
  const browser = await puppeteer.connect({ browserURL: 'http://127.0.0.1:9223', defaultViewport: null });
  // Pick any Flow context
  let ctx = null;
  for (const c of browser.browserContexts()) {
    for (const p of await c.pages()) {
      if (/labs\.google/.test(p.url() || '')) { ctx = c; break; }
    }
    if (ctx) break;
  }
  if (!ctx) ctx = browser.defaultBrowserContext();

  const page = await ctx.newPage();
  console.log('navigating to https://labs.google/fx/tools/flow ...');
  await page.goto('https://labs.google/fx/tools/flow', { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await new Promise(r => setTimeout(r, 8000));
  console.log(`final url: ${page.url()}`);
  console.log(`title:     ${await page.title()}`);
  console.log('');
  const items = await page.evaluate(() => {
    const out = [];
    for (const el of document.querySelectorAll('button, a, [role=button], [role=tab], h1, h2, h3')) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      out.push({
        tag: el.tagName,
        aria: (el.getAttribute('aria-label') || '').slice(0, 30),
        text: (el.innerText || '').slice(0, 60).replace(/\s+/g, ' ').trim(),
      });
    }
    return out;
  });
  items.forEach((it, i) => console.log(`[${String(i).padStart(2)}] ${it.tag.padEnd(7)} aria=${JSON.stringify(it.aria).padEnd(32)} text=${JSON.stringify(it.text)}`));
  await browser.disconnect();
})();
