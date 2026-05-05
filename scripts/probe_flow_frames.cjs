// Wide probe — find anything labeled "Start" or "End" or frame-related
'use strict';
const puppeteer = require('puppeteer');

(async () => {
  const browser = await puppeteer.connect({ browserURL: 'http://127.0.0.1:9223', defaultViewport: null });
  let page = null;
  for (const ctx of browser.browserContexts()) {
    for (const p of await ctx.pages()) {
      if (/labs\.google\/fx\/tools\/flow\/project\//.test(p.url() || '')) { page = p; break; }
    }
    if (page) break;
  }
  if (!page) { console.log('no project canvas tab'); process.exit(1); }
  console.log(`URL: ${page.url()}\n`);

  const items = await page.evaluate(() => {
    const out = [];
    // ALL clickable-ish elements
    for (const el of document.querySelectorAll('*')) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      const t = (el.innerText || '').trim();
      const a = (el.getAttribute('aria-label') || '').trim();
      // Match Start / End / Frame
      if (!/^(start|end|frames?|ingredients|image|video|x[1-4])$/i.test(t) &&
          !/start|end|frame|ingredient|upload|swap/i.test(a)) continue;
      // Skip very long ones
      if (t.length > 100) continue;
      out.push({
        tag: el.tagName,
        role: el.getAttribute('role') || '',
        aria: a.slice(0, 50),
        text: t.slice(0, 60),
        rect: `${Math.round(r.x)},${Math.round(r.y)} ${Math.round(r.width)}x${Math.round(r.height)}`,
      });
    }
    return out;
  });
  items.forEach((it, i) => console.log(`[${String(i).padStart(2)}] ${it.tag.padEnd(8)} role=${it.role.padEnd(10)} aria=${JSON.stringify(it.aria).padEnd(50)} rect=${it.rect.padEnd(20)} text=${JSON.stringify(it.text)}`));
  await browser.disconnect();
})();
