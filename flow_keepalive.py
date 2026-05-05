"""Long-running Chromium for labs.google/flow with persistent profile + CDP.

Run alongside chrome_keepalive.py — they use separate ports/profiles so the
two Google accounts don't collide:

    chrome_keepalive.py  -> port 9222, profile chrome_keepalive_profile/   (ChatGPT)
    flow_keepalive.py    -> port 9223, profile chrome_flow_profile/        (Flow)

ONE-TIME LOGIN:
  1. Run this script.
  2. In the visible window, sign in to labs.google/flow with the FLOW_EMAIL
     account from .env (Google SSO).
  3. Cookies persist in chrome_flow_profile/ across runs.

Usage:
    python flow_keepalive.py
"""

from __future__ import annotations

import os
import sys
import time
from pathlib import Path

from dotenv import load_dotenv
from playwright.sync_api import sync_playwright
from playwright_stealth import Stealth

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

load_dotenv()

REPO = Path(__file__).resolve().parent
PROFILE_DIR = REPO / "chrome_flow_profile"
CDP_PORT = int(os.environ.get("FLOW_CDP_PORT", "9223"))
FLOW_URL = "https://labs.google/flow"
EMAIL = os.environ.get("FLOW_EMAIL", "<unset>")


def main() -> None:
    PROFILE_DIR.mkdir(parents=True, exist_ok=True)

    print(f"[setup] launching Chromium with CDP on :{CDP_PORT}")
    print(f"[setup] profile dir: {PROFILE_DIR}")

    with sync_playwright() as pw:
        context = pw.chromium.launch_persistent_context(
            user_data_dir=str(PROFILE_DIR),
            headless=False,
            viewport=None,
            args=[
                "--start-maximized",
                f"--remote-debugging-port={CDP_PORT}",
                "--disable-blink-features=AutomationControlled",
                "--no-default-browser-check",
                "--no-first-run",
                # Disable Chrome's "Add account to Chrome?" intercept dialog
                "--disable-features=DiceWebSigninInterception,SigninInterceptBubbleV2,ProfileSwitcherPromo",
            ],
            ignore_default_args=["--enable-automation"],
        )

        # Apply playwright-stealth patches to defeat reCAPTCHA Enterprise's
        # automation fingerprinting (navigator.webdriver, plugins, languages,
        # WebGL renderer, chrome runtime, etc.). Patches both existing and
        # future pages in this context.
        try:
            Stealth().apply_stealth_sync(context)
            print(f"[setup] playwright-stealth applied to context")
        except Exception as e:
            print(f"[setup] WARNING: stealth apply failed: {e}")

        page = context.pages[0] if context.pages else context.new_page()
        try:
            page.goto(FLOW_URL, wait_until="commit", timeout=60_000)
        except Exception as e:
            print(f"[warn] failed to open Flow: {e} — open it manually")

        print("")
        print("─" * 70)
        print(f"  CDP endpoint:  http://127.0.0.1:{CDP_PORT}/json/version")
        print("")
        print("  ONE-TIME LOGIN:")
        print(f"    Sign in to labs.google/flow as: {EMAIL}")
        print(f"    Cookies persist in: {PROFILE_DIR}")
        print("")
        print("  KEEP THIS WINDOW OPEN. Run pipeline scripts in another shell:")
        print("       python generate_images.py --grade 7 --lang uz --subject 'jahon tarixi' --chapter 1")
        print("─" * 70)
        print("")

        try:
            while True:
                time.sleep(5)
                if not context.pages:
                    print("[exit] all pages closed")
                    break
        except KeyboardInterrupt:
            print("\n[exit] Ctrl+C")
        finally:
            context.close()


if __name__ == "__main__":
    main()
