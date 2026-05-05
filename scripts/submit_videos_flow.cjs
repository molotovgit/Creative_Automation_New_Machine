// Fire-and-forget VIDEO submitter via labs.google/flow.
//
// Per-tab flow: open new tab → labs.google/flow/ → click "New project" →
//   click Video tab → ensure Frames sub-tab → set count to x1 → click Start
//   → Upload image (file chooser) → type motion → click Send arrow → next.
//
// State files (separate from Gemini-app video flow):
//   .cca/flow_video_tab_map.json
//   .cca/flow_video_saved_indices.json
//
// Usage:
//   node scripts/submit_videos_flow.cjs <prompts.json>
//   node scripts/submit_videos_flow.cjs <prompts.json> 1 5 3       # skip 1, do 5, max_open=3

'use strict';
const puppeteer = require('puppeteer');
const path      = require('path');
const fs        = require('fs');

const CDP_PORT = parseInt(process.env.GEMINI_CDP_PORT || '9223', 10);
// labs.google/flow/ redirects to /flow/about (marketing). The actual project
// list with "+ New project" lives at /fx/tools/flow.
const FLOW_URL = 'https://labs.google/fx/tools/flow';
const FALLBACK_MOTION = 'drone animation slowly and slightly';
const sleep = ms => new Promise(r => setTimeout(r, ms));

const REPO     = path.resolve(__dirname, '..');
const STATE_DIR = path.join(REPO, '.cca');
const TAB_MAP_FILE = path.join(STATE_DIR, 'flow_video_tab_map.json');
const SAVED_FILE   = path.join(STATE_DIR, 'flow_video_saved_indices.json');

function readJsonOr(file, def) {
  try { return JSON.parse(fs.readFileSync(file, 'utf-8')); } catch (_) { return def; }
}
function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}
function targetIdOf(page) { return page.target()._targetId; }

function deriveImagesDir(promptsJsonPath) {
  const abs = path.resolve(promptsJsonPath);
  const parts = abs.split(path.sep);
  const idx = parts.indexOf('prompts');
  if (idx < 0) throw new Error(`input path missing 'prompts' segment: ${abs}`);
  const newParts = parts.slice();
  newParts[idx] = 'images';
  newParts[newParts.length - 1] = newParts[newParts.length - 1].replace(/\.json$/i, '');
  return newParts.join(path.sep);
}

// Click any visible element matching a text-or-aria pattern. Returns true if clicked.
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

async function waitForElByText(page, regex, timeoutMs = 15_000, opts = {}) {
  const tagFilter = opts.tags || ['button', '[role=button]', 'a', 'div', 'span'];
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = await page.evaluate(({ tagsCSS, src, flags }) => {
      const re = new RegExp(src, flags);
      const els = Array.from(document.querySelectorAll(tagsCSS));
      return els.some(el => {
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) return false;
        const t = (el.innerText || '').trim();
        const a = el.getAttribute('aria-label') || '';
        return re.test(t) || re.test(a);
      });
    }, { tagsCSS: tagFilter.join(','), src: regex.source, flags: regex.flags });
    if (found) return true;
    await sleep(500);
  }
  return false;
}

async function ensureInProject(page) {
  // Canvas URL pattern: /fx/tools/flow/project/<uuid>. Wait for it.
  // Much more reliable than checking placeholder text (which may not render
  // fully in a background tab).
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const url = page.url() || '';
    if (/\/fx\/tools\/flow\/project\/[a-f0-9-]+/i.test(url)) {
      // Wait a bit more for canvas to settle
      await sleep(2000);
      return true;
    }
    await sleep(500);
  }
  return false;
}

async function configureVideoSettings(page) {
  // Open the model+settings popup, then click in sequence:
  //   Video → Frames → 16:9 → 1x → close
  // (model/duration left at defaults: Veo 3.1 Fast, 8s)

  const opened = await page.evaluate(() => {
    const cands = Array.from(document.querySelectorAll('button, [role=button]'));
    const btn = cands.find(b => {
      const t = (b.innerText || '').trim();
      return /(?:Video|Image).*(?:x[1-4]|crop_)/i.test(t) || /(?:Video|Image)\s+\S+\s+x[1-4]/i.test(t);
    });
    if (!btn) return false;
    btn.click();
    return true;
  });
  if (!opened) {
    console.log('     [settings] popup combo button not found');
    return false;
  }
  await sleep(900);

  const clickOption = async (label) => {
    return page.evaluate((t) => {
      const els = Array.from(document.querySelectorAll('button, [role=button], [role=option], [role=tab], div, span'));
      const target = els.find(el => {
        const tt = (el.innerText || '').trim();
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) return false;
        return tt === t;
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

  let log = [];
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
  console.log(`     [settings] popup applied: ${log.join(' → ')}`);
  return true;
}

async function clickStartFrame(page) {
  // "Start" is a 50x50 DIV near coordinates (678, 829). Clicking opens an asset picker.
  const ok = await clickByText(page, /^Start$/, { tags: ['div', 'button', '[role=button]', 'span'] });
  await sleep(1500);
  return ok;
}

async function uploadImage(page, imagePath) {
  // Asset picker is open. Click "Upload image" button at bottom-left of picker.
  // This triggers a file input.
  const [chooser] = await Promise.all([
    page.waitForFileChooser({ timeout: 15_000 }),
    clickByText(page, /^Upload image$/i),
  ]);
  await chooser.accept([imagePath]);
  await sleep(4500);  // wait for thumbnail to appear in the picker AND auto-attach to Start
}

async function typeMotion(page, text) {
  // Find the prompt input "What do you want to create?"
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
  const clean = (text || '').replace(/\s*\n\s*/g, ' ').trim();
  await page.keyboard.type(clean, { delay: 12 });
  await sleep(500);
}

async function clickSendArrow(page) {
  // The arrow_forward submit button in the prompt bar's bottom-right
  const sent = await page.evaluate(() => {
    const cands = Array.from(document.querySelectorAll('button, [role=button]'));
    const btn = cands.find(b => {
      const t = (b.innerText || '').toLowerCase();
      const a = (b.getAttribute('aria-label') || '').toLowerCase();
      // Material icon "arrow_forward" renders as text via icon font
      return t.includes('arrow_forward') || /^submit$/i.test(a) || /^create$/i.test(a) || /^generate$/i.test(a);
    });
    if (!btn) return false;
    const r = btn.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return false;
    btn.click();
    return true;
  });
  if (!sent) throw new Error('Send/arrow_forward button not found');
  await sleep(800);
}

(async () => {
  const promptsPath = process.argv[2];
  if (!promptsPath) {
    console.error('Usage: node submit_videos_flow.cjs <prompts.json> [skip] [limit] [max_open]');
    process.exit(1);
  }
  const skip = parseInt(process.argv[3] || '0', 10) || 0;
  const limitArg = process.argv[4];
  const maxOpen = parseInt(process.argv[5] || '3', 10) || 3;
  const prompts = JSON.parse(fs.readFileSync(promptsPath, 'utf-8'));
  const limit = limitArg ? parseInt(limitArg, 10) : (prompts.length - skip);
  const subset = prompts.slice(skip, skip + limit);

  fs.mkdirSync(STATE_DIR, { recursive: true });
  const imagesDir = deriveImagesDir(promptsPath);

  console.log(`[fsub] ${subset.length} prompts (skip=${skip}, limit=${limit}, max_open=${maxOpen})`);
  console.log(`[fsub] images source: ${imagesDir}`);
  console.log(`[fsub] connecting to Chrome on http://127.0.0.1:${CDP_PORT}`);

  const browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${CDP_PORT}`, defaultViewport: null });

  // Find the signed-in Flow context
  let ctx = null;
  for (const c of browser.browserContexts()) {
    for (const p of await c.pages()) {
      if (/labs\.google\/flow/.test(p.url() || '')) {
        ctx = c;
        break;
      }
    }
    if (ctx) break;
  }
  if (!ctx) {
    console.error('[fsub] no labs.google/flow tab found — open Flow in Chrome first');
    await browser.disconnect();
    process.exit(2);
  }
  console.log('[fsub] found Flow context');

  const savedIdxSet = new Set(readJsonOr(SAVED_FILE, []));
  const todo = subset.filter(e => !savedIdxSet.has(e.idx));
  console.log(`[fsub] ${subset.length - todo.length} already saved, ${todo.length} to submit`);

  let submitted = 0, errors = 0;
  for (const entry of todo) {
    const padIdx = String(entry.idx).padStart(3, '0');
    const imgPath = path.join(imagesDir, `${padIdx}-${entry.slug}.png`);
    if (!fs.existsSync(imgPath)) {
      console.log(`[fsub] ${padIdx} ✗ source image missing: ${imgPath}`);
      errors++;
      continue;
    }

    // Throttle: wait until pending tabs < max_open
    while (true) {
      const tabMap = readJsonOr(TAB_MAP_FILE, {});
      const savedNow = new Set(readJsonOr(SAVED_FILE, []));
      const pending = Object.entries(tabMap).filter(([_, m]) => !savedNow.has(m.idx)).length;
      if (pending < maxOpen) break;
      await sleep(4000);
    }

    let page = null;
    try {
      page = await ctx.newPage();
      // bring to front so Chrome actually processes the page interactions
      // (background tabs throttle / don't fully render)
      await page.bringToFront();
      await page.goto(FLOW_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });
      // /fx/tools/flow takes ~6-8s to fully render the project list
      await sleep(8000);
      await page.bringToFront();

      // Wait for "New project" button to actually be in the DOM
      const newProjectVisible = await waitForElByText(page, /New project/i, 15_000);
      if (!newProjectVisible) {
        // Maybe redirected to /about — try clicking Create with Flow
        if (/\/flow\/about/.test(page.url())) {
          console.log(`[fsub] ${padIdx} on /about — clicking "Create with Flow"`);
          await clickByText(page, /^Create with Flow$/i, { tags: ['a', 'button'] });
          // New tab opens
          const deadline = Date.now() + 20_000;
          let appPage = null;
          while (Date.now() < deadline && !appPage) {
            await sleep(800);
            for (const p of await ctx.pages()) {
              const u = p.url() || '';
              if (/labs\.google/.test(u) && !/\/flow\/about/.test(u) && p !== page) {
                appPage = p;
                break;
              }
            }
          }
          if (appPage) {
            try { await page.close(); } catch (_) {}
            page = appPage;
            await page.bringToFront();
            await sleep(8000);
            console.log(`[fsub] ${padIdx} switched to app tab: ${page.url().slice(0, 80)}`);
          }
        } else {
          throw new Error('"New project" button not visible after 15s on ' + page.url().slice(0, 80));
        }
      }

      console.log(`[fsub] ${padIdx} :: ${entry.slug}  (New project)`);
      const newOk = await clickByText(page, /New project/i);
      if (!newOk) throw new Error('"New project" button not clickable on ' + page.url().slice(0, 80));
      await sleep(3500);
      const inProj = await ensureInProject(page);
      if (!inProj) throw new Error('did not enter project canvas');

      // Open settings popup and explicitly set: Video → Frames → 16:9 → 1x
      console.log(`[fsub] ${padIdx} configuring settings (Video/Frames/16:9/1x)`);
      await configureVideoSettings(page);

      console.log(`[fsub] ${padIdx} click Start → upload`);
      // Wait briefly for Start DIV to be present
      const startVisible = await waitForElByText(page, /^Start$/, 10_000, { tags: ['div', 'button', '[role=button]'] });
      if (!startVisible) throw new Error('Start frame slot not visible — canvas may not be in Video mode');
      const sOk = await clickStartFrame(page);
      if (!sOk) throw new Error('"Start" frame slot not clickable');
      await uploadImage(page, imgPath);

      const motion = (entry.motion_script || '').trim() || FALLBACK_MOTION;
      console.log(`[fsub] ${padIdx} type motion: "${motion.slice(0, 50)}..."`);
      await typeMotion(page, motion);

      console.log(`[fsub] ${padIdx} click Send`);
      await clickSendArrow(page);

      const tid = targetIdOf(page);
      const tabMap = readJsonOr(TAB_MAP_FILE, {});
      tabMap[tid] = {
        idx: entry.idx,
        slug: entry.slug,
        prompts_path: path.resolve(promptsPath),
        submitted_at: new Date().toISOString(),
        motion_used: motion,
      };
      writeJson(TAB_MAP_FILE, tabMap);

      submitted++;
      console.log(`[fsub] ${padIdx} ✓ submitted to tab ${tid.slice(0, 8)}  (${submitted}/${todo.length})`);
    } catch (e) {
      errors++;
      console.log(`[fsub] ${padIdx} ✗ ${e.message}`);
      if (page) {
        try { await page.close(); } catch (_) {}
      }
    }
    await sleep(1500);
  }

  console.log(`\n[fsub] DONE submitting — ${submitted} ok, ${errors} errors`);
  console.log(`[fsub] tab_map at ${TAB_MAP_FILE}`);
  await browser.disconnect();
})();
