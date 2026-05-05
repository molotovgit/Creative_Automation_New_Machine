// Single-tab SEQUENTIAL Flow video animator.
//
// Reuses ONE Flow project tab. For each prompt:
//   1. Configure settings popup once (Video → Frames → 16:9 → 1x)
//   2. Click Start → upload image → wait for thumbnail
//   3. Type motion script (or "drone animation slowly and slightly" fallback)
//   4. Click arrow_forward Send
//   5. Wait for new <video> on canvas
//   6. Download via Node-side https → save .mp4
//   7. Move to next prompt (no new tab, no new project)
//
// Usage:
//   node scripts/animate_flow.cjs <prompts.json> [skip] [limit]

'use strict';
const puppeteer = require('puppeteer');
const path      = require('path');
const fs        = require('fs');
const https     = require('https');

const CDP_PORT = parseInt(process.env.GEMINI_CDP_PORT || '9223', 10);
const FLOW_URL = 'https://labs.google/fx/tools/flow';
const FALLBACK_MOTION = 'drone animation slowly and slightly';
const sleep = ms => new Promise(r => setTimeout(r, ms));

const REPO     = path.resolve(__dirname, '..');
const STATE_DIR = path.join(REPO, '.cca');
const SAVED_FILE = path.join(STATE_DIR, 'flow_video_saved_indices.json');

function readJsonOr(file, def) { try { return JSON.parse(fs.readFileSync(file, 'utf-8')); } catch (_) { return def; } }
function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

function derive(promptsJsonPath, stage) {
  const abs = path.resolve(promptsJsonPath);
  const parts = abs.split(path.sep);
  const idx = parts.indexOf('prompts');
  if (idx < 0) throw new Error(`input path missing 'prompts' segment: ${abs}`);
  const newParts = parts.slice();
  newParts[idx] = stage;
  newParts[newParts.length - 1] = newParts[newParts.length - 1].replace(/\.json$/i, '');
  return newParts.join(path.sep);
}

async function clickByText(page, regex, opts = {}) {
  const tagFilter = opts.tags || ['button', '[role=button]', 'a', 'div', 'span'];
  const result = await page.evaluate(({ tagsCSS, src, flags }) => {
    const re = new RegExp(src, flags);
    const els = Array.from(document.querySelectorAll(tagsCSS));
    const hit = els.find(el => {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) return false;
      const t = (el.innerText || '').trim();
      const a = el.getAttribute('aria-label') || '';
      return re.test(t) || re.test(a);
    });
    if (!hit) return null;
    const r = hit.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  }, { tagsCSS: tagFilter.join(','), src: regex.source, flags: regex.flags });
  if (!result) return false;
  await page.mouse.click(result.x, result.y, { delay: 30 });
  return true;
}

async function configureVideoSettings(page) {
  const opened = await page.evaluate(() => {
    const cands = Array.from(document.querySelectorAll('button, [role=button]'));
    const btn = cands.find(b => /(?:Video|Image).*(?:x[1-4]|crop_)/i.test((b.innerText || '').trim()));
    if (!btn) return false;
    btn.click();
    return true;
  });
  if (!opened) return false;
  await sleep(900);

  const clickOption = async (label) => {
    return page.evaluate((t) => {
      const els = Array.from(document.querySelectorAll('button, [role=button], [role=option], [role=tab], div, span'));
      const target = els.find(el => {
        const tt = (el.innerText || '').trim();
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0 && tt === t;
      });
      if (!target) return false;
      let click = target;
      while (click && click.tagName !== 'BUTTON' && click.getAttribute('role') !== 'button') {
        click = click.parentElement;
      }
      (click || target).click();
      return true;
    }, label);
  };

  const log = [];
  if (await clickOption('Video'))  log.push('Video');   else log.push('Video?');
  await sleep(450);
  if (await clickOption('Frames')) log.push('Frames');  else log.push('Frames?');
  await sleep(450);
  if (await clickOption('16:9'))   log.push('16:9');    else log.push('16:9?');
  await sleep(450);
  if (await clickOption('1x'))     log.push('1x');      else log.push('1x?');
  await sleep(450);
  await page.keyboard.press('Escape').catch(() => {});
  await sleep(500);
  console.log(`     [settings] ${log.join(' → ')}`);
  return true;
}

async function clickStartFrame(page) {
  // First attempt: click the literal "Start" text (only present when slot is empty)
  if (await clickByText(page, /^Start$/, { tags: ['div', 'button', '[role=button]', 'span'] })) {
    await sleep(1500);
    return true;
  }
  // Fallback: after a previous upload the slot shows a thumbnail (no "Start" label).
  // Locate it structurally: the swap_horiz button sits BETWEEN Start and End.
  // Start slot is the small element just LEFT of swap.
  const startBox = await page.evaluate(() => {
    const swapBtn = Array.from(document.querySelectorAll('button, [role=button]'))
      .find(b => /swap_horiz/i.test((b.innerText || '').trim()) ||
                 /swap.*frames/i.test(b.getAttribute('aria-label') || ''));
    if (!swapBtn) return null;
    const r = swapBtn.getBoundingClientRect();
    // Start slot is roughly 45-65 px to the LEFT of swap button center
    return { x: r.x - 50, y: r.y + r.height / 2 };
  });
  if (startBox && startBox.x > 0 && startBox.y > 0) {
    await page.mouse.click(startBox.x, startBox.y, { delay: 30 });
    await sleep(1500);
    return true;
  }
  return false;
}

async function uploadImage(page, imagePath) {
  const [chooser] = await Promise.all([
    page.waitForFileChooser({ timeout: 15_000 }),
    clickByText(page, /^Upload image$/i),
  ]);
  await chooser.accept([imagePath]);
  // After upload, the asset picker shows the uploaded image as a tile and
  // we need to CLICK it to attach to the Start frame. Don't Escape — that
  // dismisses the picker without attaching, leaving Start empty.
  await sleep(3500);

  // Wait until either the Start slot is filled (auto-attach happened)
  // OR an uploaded asset tile is clickable; click it to attach.
  const deadline = Date.now() + 12_000;
  while (Date.now() < deadline) {
    // Check if "Start" label disappeared from the slot (means image attached)
    const stillEmpty = await page.evaluate(() => {
      const els = Array.from(document.querySelectorAll('div'));
      return els.some(el => {
        const t = (el.innerText || '').trim();
        const r = el.getBoundingClientRect();
        return t === 'Start' && r.width >= 40 && r.width <= 70 && r.height >= 40 && r.height <= 70;
      });
    }).catch(() => true);
    if (!stillEmpty) {
      console.log('     [upload] Start slot filled (auto-attached)');
      break;
    }

    // Try to click the first asset tile in the picker
    const clicked = await page.evaluate(() => {
      // Look for a recently-uploaded image tile (an <img> that's part of an asset card)
      const imgs = Array.from(document.querySelectorAll('img'));
      for (const img of imgs) {
        const r = img.getBoundingClientRect();
        // Asset tiles are mid-sized images in the picker (~150-300px wide)
        if (r.width < 80 || r.width > 400 || r.height < 60) continue;
        const src = img.src || '';
        if (/avatar|profile|logo|emoji|banner/i.test(src)) continue;
        // Click closest button/clickable parent
        let click = img;
        while (click && click.tagName !== 'BUTTON' && click.getAttribute('role') !== 'button') {
          click = click.parentElement;
          if (!click || click === document.body) { click = null; break; }
        }
        if (click) { click.click(); return true; }
        img.click();
        return true;
      }
      return false;
    }).catch(() => false);

    if (clicked) {
      console.log('     [upload] clicked asset tile to attach');
      await sleep(1500);
      // Re-check if Start filled
      const stillEmpty2 = await page.evaluate(() => {
        return Array.from(document.querySelectorAll('div')).some(el => {
          const t = (el.innerText || '').trim();
          const r = el.getBoundingClientRect();
          return t === 'Start' && r.width >= 40 && r.width <= 70;
        });
      }).catch(() => true);
      if (!stillEmpty2) break;
    }
    await sleep(1500);
  }
  await sleep(800);
}

async function typeMotion(page, text) {
  const promptHandle = await page.evaluateHandle(() => {
    const eds = Array.from(document.querySelectorAll('[contenteditable=true], textarea'));
    return eds.find(el => /What do you want to create/i.test(
      el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.innerText || ''
    )) || eds[0] || null;
  });
  const el = promptHandle.asElement();
  if (!el) throw new Error('Flow prompt input not found');
  await el.click();
  await sleep(300);
  await page.keyboard.down('Control'); await page.keyboard.press('a'); await page.keyboard.up('Control');
  await sleep(150);
  await page.keyboard.press('Delete');
  await sleep(200);
  const clean = (text || '').replace(/\s*\n\s*/g, ' ').trim();
  await page.keyboard.type(clean, { delay: 12 });
  await sleep(500);
}

async function clickSendArrow(page) {
  // Flow keeps the Create button DISABLED until the image-attach + prompt-text
  // validation settles. Poll up to ~30s for it to become enabled, then click.
  const findBtn = `() => {
    const cands = Array.from(document.querySelectorAll('button, [role=button]'));
    let best = null, bestX = -1;
    for (const b of cands) {
      const t = (b.innerText || '').trim().toLowerCase();
      const a = (b.getAttribute('aria-label') || '').toLowerCase();
      const isSend = t.includes('arrow_forward') || /submit|send|generate|create/.test(a);
      if (!isSend) continue;
      const r = b.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      if (r.y + r.height / 2 < window.innerHeight * 0.45) continue;
      if (r.x + r.width / 2 < window.innerWidth * 0.5) continue;
      if (r.x > bestX) { best = b; bestX = r.x; }
    }
    return best;
  }`;

  const deadline = Date.now() + 30_000;
  let lastState = null;
  while (Date.now() < deadline) {
    const state = await page.evaluate(`(${findBtn})()`).then(b => null).catch(() => null);
    // Re-evaluate via a function returning serializable info each loop
    const info = await page.evaluate(`((find) => {
      const b = (${findBtn})();
      if (!b) return { found: false };
      const disabled = b.disabled || b.getAttribute('aria-disabled') === 'true';
      const r = b.getBoundingClientRect();
      return { found: true, disabled, x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), text: (b.innerText || '').slice(0, 30) };
    })()`);
    if (!info.found) { await sleep(500); continue; }
    if (!info.disabled) {
      // Click directly via DOM
      const clicked = await page.evaluate(`(() => {
        const b = (${findBtn})();
        if (!b) return false;
        b.scrollIntoView({ block: 'center' });
        b.click();
        return true;
      })()`);
      console.log(`     [send] enabled → DOM-click fired at (${info.x}, ${info.y}) — text="${info.text.replace(/\n/g, ' ')}"`);
      await sleep(1200);
      return;
    }
    if (info.disabled !== lastState) {
      console.log(`     [send] waiting for button to enable (currently disabled)...`);
      lastState = info.disabled;
    }
    await sleep(800);
  }
  // Timeout: try Enter in prompt textarea as last resort
  console.log('     [send] WARN: button still disabled after 30s — pressing Enter as last resort');
  await page.evaluate(() => {
    const eds = Array.from(document.querySelectorAll('[contenteditable=true], textarea'));
    const el = eds.find(e => /What do you want to create/i.test(
      e.getAttribute('aria-label') || e.getAttribute('placeholder') || e.innerText || ''
    )) || eds[0];
    if (el) el.focus();
  }).catch(() => {});
  await sleep(150);
  await page.keyboard.press('Enter').catch(() => {});
  await sleep(1000);
  throw new Error('Send button stayed disabled — image likely not attached');
}

async function captureBaselineVideoSrcs(page) {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll('video')).map(v =>
      v.src || (v.querySelector('source') && v.querySelector('source').src) || ''
    )
  ).catch(() => []);
}

async function waitForNewVideo(page, baselineSrcs, maxS = 600) {
  const baseline = new Set(baselineSrcs);
  const start = Date.now();
  const deadline = start + maxS * 1000;
  while (Date.now() < deadline) {
    const found = await page.evaluate((baseList) => {
      const baseSet = new Set(baseList);
      for (const v of document.querySelectorAll('video')) {
        const r = v.getBoundingClientRect();
        if (r.width < 100 || r.height < 100) continue;
        const src = v.src || (v.querySelector('source') && v.querySelector('source').src) || '';
        if (!src || src.startsWith('about:')) continue;
        if (baseSet.has(src)) continue;
        return { src, w: Math.round(r.width), h: Math.round(r.height) };
      }
      return null;
    }, [...baseline]).catch(() => null);
    if (found) return found;
    const elapsed = Math.round((Date.now() - start) / 1000);
    if (elapsed > 0 && elapsed % 30 === 0) console.log(`     [t+${elapsed}s] waiting for video...`);
    await sleep(4000);
  }
  return null;
}

async function downloadViaNode(url, page) {
  const cookies = await page.cookies(url);
  const cookieHeader = cookies.map(c => `${c.name}=${c.value}`).join('; ');
  const ua = await page.evaluate(() => navigator.userAgent).catch(() => 'Mozilla/5.0');
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.get({
      hostname: u.hostname,
      path: u.pathname + u.search,
      headers: { 'Cookie': cookieHeader, 'User-Agent': ua, 'Accept': '*/*', 'Referer': 'https://labs.google/' },
    }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
        downloadViaNode(res.headers.location, page).then(resolve).catch(reject); return;
      }
      if (res.statusCode !== 200) { reject(new Error(`HTTP ${res.statusCode}`)); return; }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    });
    req.on('error', reject);
  });
}

async function downloadVideoBuf(page, src) {
  if (src.startsWith('data:')) return Buffer.from(src.split(',', 2)[1], 'base64');
  if (src.startsWith('blob:')) {
    const arr = await page.evaluate(async (s) => {
      const r = await fetch(s);
      const ab = await r.arrayBuffer();
      return Array.from(new Uint8Array(ab));
    }, src);
    return Buffer.from(arr);
  }
  return downloadViaNode(src, page);
}

(async () => {
  const promptsPath = process.argv[2];
  if (!promptsPath) {
    console.error('Usage: node animate_flow.cjs <prompts.json> [skip] [limit]');
    process.exit(1);
  }
  const skip = parseInt(process.argv[3] || '0', 10) || 0;
  const limitArg = process.argv[4];
  const prompts = JSON.parse(fs.readFileSync(promptsPath, 'utf-8'));

  // Build idx → entry lookup so we can fetch motion_script when iterating files
  const promptByIdx = new Map();
  for (const p of prompts) promptByIdx.set(p.idx, p);

  const imagesDir = derive(promptsPath, 'images');
  const videosDir = derive(promptsPath, 'videos');
  fs.mkdirSync(videosDir, { recursive: true });
  fs.mkdirSync(STATE_DIR, { recursive: true });

  // ── Iterate by IMAGE FILES in the images folder, sorted alphabetically.
  // Each filename "NNN-slug.png" → parse NNN, look up motion_script in prompts.json.
  if (!fs.existsSync(imagesDir)) {
    console.error(`[anim] images folder missing: ${imagesDir}`);
    process.exit(1);
  }
  const allImageFiles = fs.readdirSync(imagesDir)
    .filter(f => f.toLowerCase().endsWith('.png'))
    .sort();  // 001-... before 002-... naturally

  const fullList = [];
  for (const file of allImageFiles) {
    const m = file.match(/^(\d+)-(.+)\.png$/i);
    if (!m) {
      console.log(`[anim] skip ${file} — doesn't match NNN-slug.png pattern`);
      continue;
    }
    const idx = parseInt(m[1], 10);
    const slug = m[2];
    const entry = promptByIdx.get(idx);
    fullList.push({
      idx,
      slug,
      image_file: file,
      image_path: path.join(imagesDir, file),
      motion_script: entry ? (entry.motion_script || '') : '',
    });
  }

  const limit = limitArg ? parseInt(limitArg, 10) : (fullList.length - skip);
  const subset = fullList.slice(skip, skip + limit);

  console.log(`[anim] ${allImageFiles.length} PNGs in images folder; processing ${subset.length} (skip=${skip}, limit=${limit})`);
  console.log(`[anim] images: ${imagesDir}`);
  console.log(`[anim] videos: ${videosDir}`);
  console.log(`[anim] motions from: ${promptsPath}`);
  console.log(`[anim] connecting to Chrome on http://127.0.0.1:${CDP_PORT}`);

  const browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${CDP_PORT}`, defaultViewport: null });

  let page = null;
  for (const ctx of browser.browserContexts()) {
    for (const p of await ctx.pages()) {
      if (/labs\.google\/fx\/tools\/flow\/project\//.test(p.url() || '')) { page = p; break; }
    }
    if (page) break;
  }
  if (!page) {
    console.log(`[anim] no existing project tab — opening new one`);
    let ctx = null;
    for (const c of browser.browserContexts()) {
      for (const p of await c.pages()) {
        if (/labs\.google/.test(p.url() || '')) { ctx = c; break; }
      }
      if (ctx) break;
    }
    if (!ctx) { console.error('[anim] no Flow context — open Flow first'); process.exit(2); }
    page = await ctx.newPage();
    await page.bringToFront();
    await page.goto(FLOW_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await sleep(8000);
    if (!await clickByText(page, /New project/i)) {
      console.error('[anim] could not click New project'); process.exit(3);
    }
    await sleep(4000);
  }
  await page.bringToFront();
  console.log(`[anim] working tab: ${page.url().slice(0, 100)}`);

  console.log(`[anim] configuring settings (Video / Frames / 16:9 / 1x)`);
  await configureVideoSettings(page);

  const savedIdxs = new Set(readJsonOr(SAVED_FILE, []));
  let ok = 0, err = 0;
  const TARGET_IN_FLIGHT = 4;
  const PER_VIDEO_TIMEOUT_S = 15 * 60;

  // Filter to entries needing processing — file-existence drives skip
  const todo = subset.filter(e => {
    const padIdx = String(e.idx).padStart(3, '0');
    const outFile = path.join(videosDir, `${padIdx}-${e.slug}.mp4`);
    if (fs.existsSync(outFile) && fs.statSync(outFile).size > 50 * 1024) {
      console.log(`[anim] ${padIdx} skip (already exists, ${(fs.statSync(outFile).size/1024/1024).toFixed(1)} MB)`);
      savedIdxs.add(e.idx);
      ok++;
      return false;
    }
    return true;  // image_path was set when building fullList; we trust it exists
  });
  writeJson(SAVED_FILE, [...savedIdxs]);
  console.log(`[anim] ${todo.length} entries to animate (continuous, ${TARGET_IN_FLIGHT} in flight, FIFO)`);

  const inFlight = [];
  let baselineSrcs = await captureBaselineVideoSrcs(page);
  let nextIdx = 0;
  const totalToDo = todo.length;

  async function submitOne(entry) {
    const padIdx = String(entry.idx).padStart(3, '0');
    console.log(`[anim] ${padIdx} :: ${entry.slug}  → Start, upload ${entry.image_file}, type, send`);
    if (!await clickStartFrame(page)) throw new Error('Start frame slot not clickable');
    await uploadImage(page, entry.image_path);
    const motion = (entry.motion_script || '').trim() || FALLBACK_MOTION;
    await typeMotion(page, motion);
    await clickSendArrow(page);
  }

  async function waitForOneNewSrc(maxS) {
    const baseSet = new Set(baselineSrcs);
    const start = Date.now();
    const deadline = start + maxS * 1000;
    let lastReport = -1;
    while (Date.now() < deadline) {
      const newSrc = await page.evaluate((baseList) => {
        const set = new Set(baseList);
        for (const v of document.querySelectorAll('video')) {
          const src = v.src || (v.querySelector('source') && v.querySelector('source').src) || '';
          if (!src || src.startsWith('about:')) continue;
          // Skip Flow's promo/banner videos — keep real Veo media URLs only.
          // Don't gate on getBoundingClientRect: Flow lazy-renders video tiles
          // and leaves <video> elements at 0×0 until scrolled into view, but
          // their src is already populated.
          if (/gstatic\.com\/.*\/banners?\//.test(src)) continue;
          if (set.has(src)) continue;
          return src;
        }
        return null;
      }, [...baseSet]).catch(() => null);
      if (newSrc) return newSrc;
      const elapsed = Math.round((Date.now() - start) / 1000);
      if (elapsed > 0 && elapsed % 30 === 0 && elapsed !== lastReport) {
        console.log(`     [t+${elapsed}s] waiting for next video... in-flight=${inFlight.length}`);
        lastReport = elapsed;
      }
      await sleep(4000);
    }
    return null;
  }

  while (nextIdx < totalToDo || inFlight.length > 0) {
    while (inFlight.length < TARGET_IN_FLIGHT && nextIdx < totalToDo) {
      const entry = todo[nextIdx];
      nextIdx++;
      try {
        await submitOne(entry);
        inFlight.push({ entry, submittedAt: Date.now() });
        console.log(`[anim] ✓ submitted, queue=${inFlight.length} (${nextIdx}/${totalToDo} sent)`);
      } catch (e) {
        console.log(`[anim] submit failed for ${entry.idx}: ${e.message}`);
        err++;
        await sleep(2000);
        try {
          await submitOne(entry);
          inFlight.push({ entry, submittedAt: Date.now() });
          console.log(`[anim] ✓ retry succeeded, queue=${inFlight.length}`);
        } catch (e2) {
          console.log(`[anim] retry also failed: ${e2.message} — skipping`);
        }
      }
      await sleep(2500);
    }

    if (inFlight.length === 0) break;

    const newSrc = await waitForOneNewSrc(PER_VIDEO_TIMEOUT_S);
    if (!newSrc) {
      // Drop the head submission as failed and continue — never break the whole pipeline.
      const dropped = inFlight.shift();
      console.log(`[anim] WARN: timeout waiting for video for #${dropped.entry.idx} — dropping and continuing`);
      err++;
      continue;
    }

    const completed = inFlight.shift();
    const padIdx = String(completed.entry.idx).padStart(3, '0');
    const outFile = path.join(videosDir, `${padIdx}-${completed.entry.slug}.mp4`);
    try {
      const buf = await downloadVideoBuf(page, newSrc);
      fs.writeFileSync(outFile, buf);
      savedIdxs.add(completed.entry.idx);
      writeJson(SAVED_FILE, [...savedIdxs]);
      const dt = ((Date.now() - completed.submittedAt) / 1000).toFixed(1);
      console.log(`[anim] ${padIdx} ✓ saved ${(buf.length / 1024 / 1024).toFixed(2)} MB  ${dt}s  → ${path.basename(outFile)}  (saved: ${ok + 1}/${totalToDo})`);
      ok++;
    } catch (e) {
      console.log(`[anim] ${padIdx} ✗ download/save error: ${e.message}`);
      err++;
    }

    baselineSrcs.push(newSrc);
  }

  console.log(`\n[anim] DONE — ${ok} ok, ${err} errors`);
  console.log(`[anim] videos at: ${videosDir}`);
  try { await browser.disconnect(); } catch (_) {}
  // Force exit — puppeteer can leave hanging handles after disconnect that
  // prevent natural process termination (the run_animator wrapper waits on
  // child exit before printing its DONE summary).
  process.exit(ok > 0 || err === 0 ? 0 : 1);
})();
