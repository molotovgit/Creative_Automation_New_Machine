// Probe the current state of any labs.google/flow tab.
'use strict';
const puppeteer = require('puppeteer');

(async () => {
  const browser = await puppeteer.connect({ browserURL: 'http://127.0.0.1:9223', defaultViewport: null });
  let i = 0;
  for (const ctx of browser.browserContexts()) {
    for (const page of await ctx.pages()) {
      if (!/labs\.google\/flow/.test(page.url() || '')) continue;
      i++;
      console.log(`\n[${i}] url: ${page.url()}`);
      try { console.log(`    title: ${await page.title()}`); } catch {}
      const items = await page.evaluate(() => {
        const out = [];
        for (const el of document.querySelectorAll('button, a, [role=button], [role=tab]')) {
          const r = el.getBoundingClientRect();
          if (r.width === 0 || r.height === 0) continue;
          out.push({
            tag: el.tagName,
            aria: (el.getAttribute('aria-label') || '').slice(0, 30),
            text: (el.innerText || '').slice(0, 60).replace(/\s+/g, ' ').trim(),
          });
        }
        return out.slice(0, 40);
      });
      console.log(`    --- buttons/links ---`);
      items.forEach((it, idx) => console.log(`    [${String(idx).padStart(2)}] ${it.tag.padEnd(7)} aria=${JSON.stringify(it.aria).padEnd(32)} text=${JSON.stringify(it.text)}`));
    }
  }
  await browser.disconnect();
})();
