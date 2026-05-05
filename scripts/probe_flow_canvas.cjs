// Probe a project canvas (any tab on /fx/tools/flow/project/)
'use strict';
const puppeteer = require('puppeteer');

(async () => {
  const browser = await puppeteer.connect({ browserURL: 'http://127.0.0.1:9223', defaultViewport: null });
  let page = null;
  for (const ctx of browser.browserContexts()) {
    for (const p of await ctx.pages()) {
      if (/labs\.google\/fx\/tools\/flow\/project\//.test(p.url() || '')) {
        page = p;
        break;
      }
    }
    if (page) break;
  }
  if (!page) {
    // fall back to any /fx/tools/flow tab
    for (const ctx of browser.browserContexts()) {
      for (const p of await ctx.pages()) {
        if (/labs\.google\/fx\/tools\/flow/.test(p.url() || '')) {
          page = p;
          break;
        }
      }
      if (page) break;
    }
  }
  if (!page) { console.log('no flow tab'); process.exit(1); }
  console.log(`URL: ${page.url()}\n`);

  const items = await page.evaluate(() => {
    const out = [];
    const sels = ['button', 'a', '[role=button]', '[role=tab]', '[contenteditable=true]', 'textarea', 'input'];
    for (const sel of sels) {
      for (const el of document.querySelectorAll(sel)) {
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) continue;
        out.push({
          tag: el.tagName,
          role: el.getAttribute('role') || '',
          aria: (el.getAttribute('aria-label') || '').slice(0, 35),
          ph: (el.getAttribute('placeholder') || '').slice(0, 35),
          text: (el.innerText || '').slice(0, 70).replace(/\s+/g, ' ').trim(),
        });
      }
    }
    return out.slice(0, 50);
  });
  items.forEach((it, i) => console.log(`[${String(i).padStart(2)}] ${it.tag.padEnd(8)} role=${it.role.padEnd(10)} aria=${JSON.stringify(it.aria).padEnd(36)} ph=${JSON.stringify(it.ph).padEnd(20)} text=${JSON.stringify(it.text)}`));
  await browser.disconnect();
})();
