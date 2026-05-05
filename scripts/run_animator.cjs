// Autonomous wrapper around animate_flow.cjs.
//
// Re-launches the animator after any exit (success, error, crash) until
// every PNG in the images folder has a matching .mp4 in the videos folder.
// Idle-watchdog: if no new file is saved for IDLE_KILL_S, kill the child
// and restart. Hard cap on consecutive failed restarts to avoid infinite loops.
//
// Usage:
//   node scripts/run_animator.cjs <prompts.json>

'use strict';
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const promptsPath = process.argv[2];
if (!promptsPath) { console.error('Usage: node run_animator.cjs <prompts.json>'); process.exit(1); }

const RESTART_BACKOFF_MS = 8_000;
const IDLE_KILL_S = 25 * 60;        // if no new video for 25 min, restart
const MAX_CONSECUTIVE_FAILS = 8;    // bail if 8 restarts produce zero new files in a row

function derive(p, stage) {
  const abs = path.resolve(p);
  const parts = abs.split(path.sep);
  const idx = parts.indexOf('prompts');
  const out = parts.slice();
  out[idx] = stage;
  out[out.length - 1] = out[out.length - 1].replace(/\.json$/i, '');
  return out.join(path.sep);
}

const imagesDir = derive(promptsPath, 'images');
const videosDir = derive(promptsPath, 'videos');

function countPngs() {
  if (!fs.existsSync(imagesDir)) return 0;
  return fs.readdirSync(imagesDir).filter(f => f.toLowerCase().endsWith('.png')).length;
}
function countMp4s() {
  if (!fs.existsSync(videosDir)) return 0;
  return fs.readdirSync(videosDir).filter(f => f.toLowerCase().endsWith('.mp4')
    && fs.statSync(path.join(videosDir, f)).size > 50 * 1024).length;
}

const target = countPngs();
console.log(`[runner] target: ${target} videos (matching ${imagesDir})`);
console.log(`[runner] currently saved: ${countMp4s()}`);

let consecutiveFails = 0;
let restartCount = 0;

async function runOnce() {
  return new Promise((resolve) => {
    const startCount = countMp4s();
    const args = [path.join(__dirname, 'animate_flow.cjs'), promptsPath];
    console.log(`[runner] launching animator (attempt #${restartCount + 1}, saved=${startCount}/${target})`);
    const child = spawn(process.execPath, args, { stdio: 'inherit' });

    let lastProgress = Date.now();
    let lastSeen = startCount;
    const watchdog = setInterval(() => {
      const now = countMp4s();
      if (now > lastSeen) {
        lastSeen = now;
        lastProgress = Date.now();
      }
      const idleS = Math.round((Date.now() - lastProgress) / 1000);
      if (idleS >= IDLE_KILL_S) {
        console.log(`[runner] WATCHDOG: no progress for ${idleS}s — killing child`);
        try { child.kill('SIGKILL'); } catch (_) {}
      }
    }, 30_000);

    child.on('exit', (code, signal) => {
      clearInterval(watchdog);
      const endCount = countMp4s();
      const gained = endCount - startCount;
      console.log(`[runner] animator exited (code=${code}, signal=${signal}) — gained ${gained} this run, total ${endCount}/${target}`);
      if (gained > 0) consecutiveFails = 0;
      else consecutiveFails++;
      restartCount++;
      resolve();
    });
  });
}

(async () => {
  while (countMp4s() < target) {
    if (consecutiveFails >= MAX_CONSECUTIVE_FAILS) {
      console.log(`[runner] STOPPING: ${MAX_CONSECUTIVE_FAILS} restarts in a row produced no new files. Manual intervention needed.`);
      process.exit(2);
    }
    await runOnce();
    if (countMp4s() < target) {
      console.log(`[runner] backoff ${RESTART_BACKOFF_MS / 1000}s before next launch`);
      await new Promise(r => setTimeout(r, RESTART_BACKOFF_MS));
    }
  }
  console.log(`[runner] ✓ DONE — ${countMp4s()}/${target} videos saved`);
})();
