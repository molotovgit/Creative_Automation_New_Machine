# Creative Automation — Quick Guide

Turn any Notion textbook chapter into 80 images + 80 animated videos. **One config block, two double-clicks.**

---

## First-time setup (do once)

1. **Double-click `setup.bat`** (in `D:\Creative_Automation\`)
   - Installs Python dependencies
   - Launches **two Chrome windows** (one for ChatGPT, one for Gemini + Flow)
2. **Sign in inside each window:**
   - **Window 1 (ChatGPT)** → log in to chatgpt.com
   - **Window 2 (Gemini + Flow)** → log in to gemini.google.com (tab 1) **and** labs.google/fx/tools/flow (tab 2)
3. **Leave both Chrome windows open.** Sign-in is one-time — sessions persist.

---

## Run a chapter

1. **Open** `D:\Creative_Automation\scripts\run_pipeline.cjs` in any text editor
2. **Edit the `CONFIG` block at the top** (around line 27):

   ```js
   const CONFIG = {
     NOTION_URL: 'https://www.notion.so/PASTE-YOUR-CHAPTER-LINK-HERE',
     GRADE:   7,                  // 5–11
     LANG:    'uz',               // 'uz' or 'ru'
     SUBJECT: 'jahon tarixi',     // subject name
     CHAPTER: 1,                  // chapter number
   };
   ```

   **`GRADE`, `LANG`, `SUBJECT`, `CHAPTER` are what actually drive the fetch.** The URL is for your reference (printed at the top of the run).

3. **Save the file.**
4. **Double-click `start.bat`.**
5. **Walk away.** Total time ≈ 3–4 hours per chapter.

---

## What runs (5 stages)

| # | Stage | What happens | Time |
|---|---|---|---|
| 1 | **FETCH** | Pulls chapter text from Notion | ~10 sec |
| 2 | **REFINE** | ChatGPT rewrites the chapter | 3–6 min |
| 3 | **PROMPTS** | ChatGPT generates 80 image prompts (4 batches × 20) | 10–20 min |
| 4 | **IMAGES** | Gemini generates + saves 80 PNGs (10 parallel tabs) | ~60 min |
| 5 | **ANIMATE** | Flow turns each PNG into an 8-sec MP4 (4 in flight) | ~2 hr |

**Each stage skips itself if its output already exists** — re-running after a crash picks up exactly where it left off.

---

## Where everything is saved

All paths under `D:\Creative_Automation\`:

| Stage output | Folder |
|---|---|
| Raw chapter (Notion) | `chapters\g{GRADE}-{LANG}\{subject-slug}\ch{NN}-{title}.md` |
| Refined chapter (ChatGPT) | `refined\g{GRADE}-{LANG}\{subject-slug}\ch{NN}-{title}.md` |
| 80 prompts (the JSON the rest of the pipeline reads) | `prompts\g{GRADE}-{LANG}\{subject-slug}\ch{NN}-{title}.json` |
| 80 images | `images\g{GRADE}-{LANG}\{subject-slug}\ch{NN}-{title}\NNN-{slug}.png` |
| 80 videos | `videos\g{GRADE}-{LANG}\{subject-slug}\ch{NN}-{title}\NNN-{slug}.mp4` |

**Concrete example** (G7 Uzbek, jahon tarixi, ch10 Saljuqiylar):

```
chapters\g7-uz\jahon-tarixi\ch10-saljuqiylar-davlati.md
refined\g7-uz\jahon-tarixi\ch10-saljuqiylar-davlati.md
prompts\g7-uz\jahon-tarixi\ch10-saljuqiylar-davlati.json
images\g7-uz\jahon-tarixi\ch10-saljuqiylar-davlati\001-...png ... 080-...png
videos\g7-uz\jahon-tarixi\ch10-saljuqiylar-davlati\001-...mp4 ... 080-...mp4
```

---

## Troubleshooting

**Pipeline halts on stage 1 with "ModuleNotFoundError"** — run `setup.bat` once (it installs Python deps).

**Pipeline halts on pre-flight with "Chrome not reachable"** — your Chrome window for that port is closed. Run `setup.bat` again (it skips windows that are already up).

**A stage failed mid-run** — fix whatever the error says, then double-click `start.bat` again. Completed stages skip automatically.

**Want to redo a stage** — delete its output file/folder, then re-run `start.bat`.

**Want to run a different chapter** — edit the `CONFIG` block, save, double-click `start.bat`.

---

## File reference

| File | Purpose |
|---|---|
| `setup.bat` | Run **once** to install deps and launch Chrome windows |
| `start.bat` | Run **every time** to start the pipeline |
| `scripts\run_pipeline.cjs` | The orchestrator — **edit the CONFIG block here** |
| `.env` | API keys (don't share) |
| `refine_prompt.txt` | The formula ChatGPT uses to refine chapters |
| `80_prompt_formula.txt` | The formula ChatGPT uses to generate image prompts |
