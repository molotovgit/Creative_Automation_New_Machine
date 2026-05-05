# Quickstart — new setup method (single double-click)

The fast path. Edit one file, double-click, walk away.

> Prefer the long-form walkthrough? See [SETUP.md](SETUP.md).

---

## 1. Install prerequisites (one-time, per machine)

Open **PowerShell as Administrator** and paste:

```powershell
winget install --id OpenJS.NodeJS.LTS --silent --accept-source-agreements --accept-package-agreements
winget install --id Python.Python.3.12 --silent --accept-source-agreements --accept-package-agreements
winget install --id Google.Chrome      --silent --accept-source-agreements --accept-package-agreements
winget install --id Git.Git            --silent --accept-source-agreements --accept-package-agreements
```

**Close and reopen** your terminal afterwards so the new `PATH` takes effect.

> Not on Windows 11? See [SETUP.md § 1 — Manual download](SETUP.md#manual-download-any-os).

---

## 2. Clone the repo

```
git clone https://github.com/molotovgit/Creative_Automation.git
cd Creative_Automation
```

---

## 3. Edit `start.bat` — set which chapter to process

Open `start.bat` in any text editor. The top has a **CONFIG block**:

```bat
REM ============================================================
REM   PIPELINE CONFIG — edit these 5 values, then double-click
REM ============================================================
set "CCA_NOTION_URL=paste your notion link here"
set "CCA_GRADE=7"
set "CCA_LANG=uz"
set "CCA_SUBJECT=jahon tarixi"
set "CCA_CHAPTER=1"
REM ============================================================
```

Set the 5 values:

| Variable | What it is | Example |
|---|---|---|
| `CCA_NOTION_URL` | Notion page URL of the chapter (informational, printed in logs) | `https://www.notion.so/10-mavzu-...` |
| `CCA_GRADE` | Grade number, 5–11 | `7` |
| `CCA_LANG` | `uz` or `ru` | `uz` |
| `CCA_SUBJECT` | Subject name (fuzzy-matched in Notion) | `jahon tarixi` |
| `CCA_CHAPTER` | Chapter number | `10` |

Save the file.

---

## 4. Double-click `start.bat`

That's it. `start.bat` does everything end-to-end, in this order:

1. **Checks** Node.js + Python are installed (clear error if not — re-do step 1)
2. **First run only:** copies `.env.example` → `.env` and **opens it in Notepad**. Fill in your real credentials, save, and **close Notepad** to continue:

   ```
   NOTION_API_KEY=secret_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
   CHATGPT_EMAIL=your-chatgpt-email@example.com
   CHATGPT_PASSWORD=your-chatgpt-password
   GEMINI_EMAIL=your-gemini-email@example.com
   GEMINI_PASSWORD=your-gemini-password
   CDP_PORT=9222               ← leave as-is
   GEMINI_CDP_PORT=9223        ← leave as-is
   ```

   See [§ Where to get the Notion API key](#where-to-get-the-notion-api-key) below.

3. **Installs** Node deps (`npm install`) and Python deps (`pip install`) — idempotent, fast on re-runs
4. **Launches** both Chrome windows (port 9222 ChatGPT, port 9223 Gemini + Flow). Skips windows already up.
5. **Pauses** — sign in inside each Chrome window if first time:
   - Window 1 → chatgpt.com
   - Window 2 → gemini.google.com **and** labs.google/fx/tools/flow

   Sign-in is **once per machine** — sessions persist between runs. Press **ENTER** in the terminal when ready (or immediately if already signed in).

6. **Runs the pipeline** — 5 stages: fetch → refine → prompts → images → animate. Walk away. ~50–60 min total for a fresh chapter.

---

## Running another chapter

1. Edit the 5 `CCA_*` values at the top of `start.bat`
2. Double-click `start.bat`

`.env` and Chrome sign-ins persist — you only do steps 1–2 of the first-time setup once.

---

## Where to get the Notion API key

1. Go to https://www.notion.so/profile/integrations
2. Click "+ New integration"
3. Give it a name, pick the workspace that has your textbooks
4. Copy the "Internal Integration Secret" (starts with `secret_` or `ntn_`)
5. Open your textbook root page in Notion → click "..." (top right) → "+ Add connections" → select your integration

The integration must have access to every page the pipeline will read.

---

## Notion workspace structure (must match)

The pipeline expects this hierarchy in your Notion workspace:

```
<Grade root page>             (search-discoverable: "Grade 7", "7-sinf", etc.)
└── <Subject page>             ("Tarix", "Jahon Tarixi", "Algebra", ...)
    └── <Chapter page>         (titled "1-mavzu: ...", "Chapter 1: ...", etc.)
        └── chapter content
```

If your Notion doesn't follow this, the FETCH stage will fail. Either restructure Notion or edit `tools/notion/navigator.py` to match your structure.

---

## Output locations

```
chapters/g{GRADE}-{LANG}/{subject-slug}/ch{NN}-{title}.md     ← Notion fetch
refined/g{GRADE}-{LANG}/{subject-slug}/ch{NN}-{title}.md       ← ChatGPT-refined
prompts/g{GRADE}-{LANG}/{subject-slug}/ch{NN}-{title}.json    ← 80 prompts
images/g{GRADE}-{LANG}/{subject-slug}/ch{NN}-{title}/*.png    ← 80 PNGs
videos/g{GRADE}-{LANG}/{subject-slug}/ch{NN}-{title}/*.mp4    ← 80 MP4s
```

---

## Troubleshooting

**"ERROR: Node.js not installed" / "ERROR: Python not installed"**
Step 1 wasn't done, or the terminal hasn't picked up the new `PATH`. Close and reopen the terminal, then re-run.

**"Chrome not reachable on port 9222 / 9223"**
A Chrome window was closed. Just re-run `start.bat` — it relaunches missing windows.

**"Auto-login failed" or stuck on a Google login page**
You need to sign in once manually inside the Chrome window the script launched. Sessions persist after that.

**"No fetched chapter found"**
Your Notion structure doesn't match (see above), or your integration doesn't have access to the textbook pages (re-check the "Add connections" step on your textbook page in Notion).

**Stage failed mid-run**
Re-run `start.bat`. Completed stages skip; the pipeline picks up where it left off (file-existence-driven).

**Want to redo a specific stage**
Delete that stage's output folder/file (e.g., delete `images/g7-uz/...` to redo image generation), then re-run `start.bat`.

---

## What `start.bat` actually does (under the hood)

| Step | Action | Idempotent? |
|---|---|---|
| 1 | `where node` / `where python` — fail-fast prereq check | yes |
| 2 | `if not exist .env: copy .env.example .env && notepad .env` | yes — won't overwrite existing `.env` |
| 3 | `call npm install --silent` | yes — npm skips already-installed packages |
| 4 | `pip install -q -r requirements.txt` | yes — pip skips already-installed packages |
| 5 | `node scripts/setup_chrome.cjs` — launches Chrome windows | yes — skips windows already up |
| 6 | `pause` — wait for user to confirm Chrome sign-in | n/a |
| 7 | `node scripts/run_pipeline.cjs` — runs the 5-stage pipeline; reads `CCA_*` env vars set by step 0 | yes — stages skip if their output already exists on disk |

The CONFIG block at the top of `start.bat` is just `set CCA_*` calls. Those env vars flow into `scripts/run_pipeline.cjs`, which uses them as the chapter target. The fallback literals inside `run_pipeline.cjs` only kick in if you run it directly without `start.bat`.
