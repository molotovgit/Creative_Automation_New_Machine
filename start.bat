@echo off
setlocal
cd /d "%~dp0"

REM ============================================================
REM   PIPELINE CONFIG — edit these 5 values, then double-click
REM ============================================================
set "CCA_NOTION_URL=paste your notion link here"
set "CCA_GRADE=7"
set "CCA_LANG=uz"
set "CCA_SUBJECT=jahon tarixi"
set "CCA_CHAPTER=1"
REM ============================================================


REM ---- 1. Prerequisite check ----
where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo ERROR: Node.js not installed. See SETUP.md step 1, then re-run.
  pause
  exit /b 1
)
where python >nul 2>nul
if errorlevel 1 (
  echo.
  echo ERROR: Python not installed. See SETUP.md step 1, then re-run.
  pause
  exit /b 1
)


REM ---- 2. Bootstrap .env from template (first run only) ----
if not exist .env (
  if not exist .env.example (
    echo ERROR: .env.example missing — cannot bootstrap .env.
    pause
    exit /b 1
  )
  copy .env.example .env >nul
  echo.
  echo ============================================================
  echo   .env created from template. Notepad will open it now.
  echo   Fill in your real credentials, save, and CLOSE Notepad.
  echo ============================================================
  notepad .env
  echo.
  echo .env saved. Continuing...
)


REM ---- 3. Install deps (idempotent — fast on re-run) ----
echo.
echo Checking Node dependencies...
call npm install --silent

echo Checking Python dependencies...
pip install -q -r requirements.txt


REM ---- 4. Ensure both Chrome windows are running ----
echo.
echo Ensuring Chrome windows are up...
node scripts\setup_chrome.cjs


REM ---- 5. Pause for manual sign-in (one-time per Chrome profile) ----
echo.
echo ============================================================
echo   If Chrome was just launched for the first time, sign in to:
echo     Window 1: chatgpt.com
echo     Window 2: gemini.google.com AND labs.google/fx/tools/flow
echo   Then press ENTER to start the pipeline.
echo   (If sessions are already signed in from before, just press ENTER.)
echo ============================================================
pause


REM ---- 6. Run pipeline (CCA_* env vars override CONFIG defaults) ----
node scripts\run_pipeline.cjs


echo.
echo ============================================================
echo   Pipeline finished (or stopped). Press any key to close.
echo ============================================================
pause >nul
