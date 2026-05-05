'use strict';
const puppeteer = require('puppeteer');

(async () => {
  const browser = await puppeteer.connect({ browserURL: 'http://127.0.0.1:9223', defaultViewport: null });
  for (const ctx of browser.browserContexts()) {
    for (const page of await ctx.pages()) {
      const url = page.url() || '';
      if (!/labs\.google\/fx\/tools\/flow/.test(url)) continue;
      console.log(`\n[Flow tab]  ${url}`);
      const info = await page.evaluate(() => {
        const vids = Array.from(document.querySelectorAll('video')).map(v => {
          const r = v.getBoundingClientRect();
          const src = v.src || (v.querySelector('source') && v.querySelector('source').src) || '';
          return { src: src.slice(0, 80), w: Math.round(r.width), h: Math.round(r.height) };
        });
        const errText = (document.body.innerText || '').match(/error|failed|cannot|unable|sorry|try again|quota|limit|credit/gi);
        const last500 = (document.body.innerText || '').slice(-500);
        return {
          videoCount: vids.length,
          videos: vids,
          errorMatches: errText ? errText.slice(0, 10) : [],
          lastText: last500,
        };
      }).catch(e => ({ error: e.message }));
      console.log(JSON.stringify(info, null, 2));
    }
  }
  await browser.disconnect();
})();
