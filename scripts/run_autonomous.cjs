// Autonomous orchestrator: owns submit_prompts + save_images, monitors them,
// auto-restarts the saver if it stalls, respawns the submitter if it dies
// with work remaining. Exits when all expected images are saved.
//
// Run-and-forget — doesn't need any user intervention until done.
//
// Usage:
//   node scripts/run_autonomous.cjs <prompts.json>
//   node scripts/run_autonomous.cjs <prompts.json> --max-open 10

'use strict';
const { spawn } = require('child_process');
const path = require('path');
const fs   = require('fs');

const REPO       = path.resolve(__dirname, '..');
const STATE_DIR  = path.join(REPO, '.cca');
const SAVED_FILE = path.join(STATE_DIR, 'saved_indices.json');
const TAB_MAP_FILE = path.join(STATE_DIR, 'tab_map.json');

const PROMPTS_PATH = process.argv[2];
if (!PROMPTS_PATH) {
  console.error('Usage: node run_autonomous.cjs <prompts.json> [--max-open N]');
  process.exit(1);
}
if (!fs.existsSync(PROMPTS_PATH)) {
  console.error(`prompts file not found: ${PROMPTS_PATH}`);
  process.exit(1);
}
const TOTAL = JSON.parse(fs.readFileSync(PROMPTS_PATH, 'utf-8')).length;

const maxOpenIdx = process.argv.indexOf('--max-open');
const maxOpen = (maxOpenIdx > 0 && process.argv[maxOpenIdx + 1]) ? process.argv[maxOpenIdx + 1] : '10';

const POLL_MS         = 15_000;   // orchestrator status interval
const STALL_TIMEOUT_MS = 150_000;  // 2.5 min with no save → restart save
const SAVER_RESTART_MS = 3_000;

function readJsonOr(file, def) {
  try { return JSON.parse(fs.readFileSync(file, 'utf-8')); } catch (_) { return def; }
}

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

// Derive the chapter's images folder from the prompts.json path.
// prompts/g7-uz/jahon-tarixi/ch10-X.json  →  images/g7-uz/jahon-tarixi/ch10-X/
function chapterImagesDir(promptsPath) {
  const abs = path.resolve(promptsPath);
  const parts = abs.split(path.sep);
  const idx = parts.indexOf('prompts');
  if (idx < 0) throw new Error(`prompts path missing 'prompts' segment: ${abs}`);
  const out = parts.slice();
  out[idx] = 'images';
  out[out.length - 1] = out[out.length - 1].replace(/\.json$/i, '');
  return out.join(path.sep);
}

function diskSavedIndices(imagesDir) {
  if (!fs.existsSync(imagesDir)) return [];
  const out = [];
  for (const f of fs.readdirSync(imagesDir)) {
    if (!f.toLowerCase().endsWith('.png')) continue;
    if (fs.statSync(path.join(imagesDir, f)).size < 10 * 1024) continue;
    const m = f.match(/^(\d+)-/);
    if (m) out.push(parseInt(m[1], 10));
  }
  return out.sort((a, b) => a - b);
}

let submitProc = null;
let saveProc   = null;
let saveSpawnPending = false;  // true between scheduling spawn and child actually running
let lastSaveCount = 0;
let lastProgressTime = Date.now();
let saverRestarts = 0;

function ts() {
  return new Date().toISOString().substring(11, 19);
}

function logSubmit(buf) {
  process.stdout.write(buf.toString().split('\n').filter(l => l).map(l => `${ts()} [SUB] ${l}\n`).join(''));
}
function logSave(buf) {
  process.stdout.write(buf.toString().split('\n').filter(l => l).map(l => `${ts()} [SAV] ${l}\n`).join(''));
}

function spawnSubmit() {
  console.log(`${ts()} [ORCH] spawning submit_prompts (max-open=${maxOpen})`);
  const p = spawn('node', ['scripts/submit_prompts.cjs', PROMPTS_PATH, '0', String(TOTAL), maxOpen], {
    cwd: REPO,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  p.stdout.on('data', logSubmit);
  p.stderr.on('data', d => process.stderr.write(`${ts()} [SUB-ERR] ${d}`));
  p.on('exit', (code, sig) => {
    console.log(`${ts()} [ORCH] submit exited code=${code} sig=${sig}`);
    submitProc = null;
  });
  submitProc = p;
}

function spawnSave() {
  saveSpawnPending = false;
  saverRestarts++;
  console.log(`${ts()} [ORCH] spawning save_images (restart #${saverRestarts})`);
  const p = spawn('node', ['scripts/save_images.cjs', PROMPTS_PATH, '--watch'], {
    cwd: REPO,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  p.stdout.on('data', logSave);
  p.stderr.on('data', d => process.stderr.write(`${ts()} [SAV-ERR] ${d}`));
  p.on('exit', (code, sig) => {
    console.log(`${ts()} [ORCH] save exited code=${code} sig=${sig}`);
    saveProc = null;
  });
  saveProc = p;
}

function scheduleSaveSpawn(reason) {
  if (saveSpawnPending) {
    return;  // already scheduled; don't double-schedule
  }
  saveSpawnPending = true;
  console.log(`${ts()} [ORCH] scheduling save respawn in ${SAVER_RESTART_MS}ms (${reason})`);
  setTimeout(spawnSave, SAVER_RESTART_MS);
}

function killSave() {
  if (saveProc) {
    try { saveProc.kill(); } catch (_) {}
    saveProc = null;
  }
}

function killAll() {
  if (submitProc) { try { submitProc.kill(); } catch (_) {} submitProc = null; }
  killSave();
}

process.on('SIGINT',  () => { console.log('\n[orch] SIGINT received, shutting down'); killAll(); process.exit(0); });
process.on('SIGTERM', () => { console.log('\n[orch] SIGTERM received, shutting down'); killAll(); process.exit(0); });

(async () => {
  console.log(`${ts()} [ORCH] starting — target ${TOTAL} images`);
  console.log(`${ts()} [ORCH] prompts: ${PROMPTS_PATH}`);
  console.log(`${ts()} [ORCH] poll=${POLL_MS}ms, stall_timeout=${STALL_TIMEOUT_MS}ms, max_open=${maxOpen}`);
  console.log('');

  // Source of truth = ACTUAL files on disk for THIS chapter, not the global
  // .cca/saved_indices.json (which leaks between chapters and would falsely
  // mark a fresh chapter as already-complete).
  const imagesDir = chapterImagesDir(PROMPTS_PATH);
  const onDisk = diskSavedIndices(imagesDir);
  // ALWAYS sync state files to disk + clear tab_map. Tab_map is per-run state
  // (Chrome tab IDs from a previous run point at dead tabs); no cross-run value.
  // Submit_prompts will repopulate tab_map fresh. saved_indices is mirrored to disk.
  console.log(`${ts()} [ORCH] state reset: syncing saved_indices to ${onDisk.length} on-disk entries, clearing tab_map`);
  writeJson(SAVED_FILE, onDisk);
  writeJson(TAB_MAP_FILE, {});
  lastSaveCount = onDisk.length;
  console.log(`${ts()} [ORCH] images dir: ${imagesDir}`);
  console.log(`${ts()} [ORCH] starting with ${lastSaveCount}/${TOTAL} already on disk`);
  if (lastSaveCount >= TOTAL) {
    console.log(`${ts()} [ORCH] already complete — nothing to do`);
    process.exit(0);
  }

  spawnSubmit();
  spawnSave();

  setInterval(() => {
    const saved = readJsonOr(SAVED_FILE, []);
    const tabs  = readJsonOr(TAB_MAP_FILE, {});
    const pending = Object.entries(tabs).filter(([_tid, m]) => !saved.includes(m.idx)).length;

    if (saved.length > lastSaveCount) {
      lastSaveCount = saved.length;
      lastProgressTime = Date.now();
    }
    const stalledMs = Date.now() - lastProgressTime;

    console.log(
      `${ts()} [ORCH] saved=${saved.length}/${TOTAL}` +
      `  pending=${pending}` +
      `  submit=${submitProc ? 'alive' : 'DEAD'}` +
      `  save=${saveProc ? 'alive' : 'DEAD'}` +
      `  stall=${Math.floor(stalledMs / 1000)}s`
    );

    // Restart save if stalled while there's pending work, OR respawn if it died.
    // saveSpawnPending guards against multiple ticks scheduling concurrent spawns
    // before the previous setTimeout has fired.
    if (saveProc && pending > 0 && stalledMs > STALL_TIMEOUT_MS) {
      console.log(`${ts()} [ORCH] saver STALLED ${Math.floor(stalledMs / 1000)}s with ${pending} pending — restarting`);
      killSave();
      lastProgressTime = Date.now();  // reset stall clock
      scheduleSaveSpawn('stall-restart');
    } else if (!saveProc && saved.length < TOTAL) {
      scheduleSaveSpawn('dead-respawn');
    }

    // Respawn submit if it died but tabs+saved < total
    if (!submitProc && (saved.length + pending) < TOTAL) {
      console.log(`${ts()} [ORCH] submit dead with work remaining — respawning`);
      setTimeout(spawnSubmit, SAVER_RESTART_MS);
    }

    // Done condition
    if (saved.length >= TOTAL) {
      console.log(`\n${ts()} [ORCH] === DONE ===  ${saved.length}/${TOTAL} saved`);
      console.log(`${ts()} [ORCH] images at: D:\\Creative_Automation\\images\\g7-uz\\jahon-tarixi\\ch01-german-qabilalari-va-rim-imperiyasi\\`);
      console.log(`${ts()} [ORCH] saver restarted ${saverRestarts - 1} times during run`);
      killAll();
      process.exit(0);
    }
  }, POLL_MS);
})();
