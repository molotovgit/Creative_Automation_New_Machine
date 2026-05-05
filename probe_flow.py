"""Probe Flow — auto-login if needed, then dump UI for selector discovery.

Goal: figure out which buttons / inputs we need to drive in generate_images.py.
This script:
  1. Connects to flow_keepalive (CDP :9223)
  2. Navigates to https://labs.google/fx/tools/flow (the actual app)
  3. If not signed in, runs Google SSO with FLOW_EMAIL / FLOW_PASSWORD
  4. Once on the Flow editor, dumps all visible buttons, links, inputs,
     and obvious "model selector" / "Nano Banana" / "Generate" candidates
"""

from __future__ import annotations

import os
import re
import sys
import time
from pathlib import Path
from urllib.parse import urlparse

from dotenv import load_dotenv
from playwright.sync_api import sync_playwright, Page

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")

load_dotenv()

CDP_PORT = int(os.environ.get("FLOW_CDP_PORT", "9223"))
EMAIL = os.environ.get("FLOW_EMAIL", "")
PASSWORD = os.environ.get("FLOW_PASSWORD", "")
FLOW_URL = "https://labs.google/fx/tools/flow"


def host_of(url: str) -> str:
    try:
        return (urlparse(url or "").hostname or "").lower()
    except Exception:
        return ""


def click_first(page: Page, selectors: list, timeout_ms: int = 10_000) -> bool:
    """Try each selector; click the first visible match."""
    deadline = time.time() + timeout_ms / 1000.0
    while time.time() < deadline:
        for sel in selectors:
            try:
                loc = page.locator(sel).first
                if loc.count() > 0 and loc.is_visible():
                    loc.click(timeout=3000)
                    return True
            except Exception:
                continue
        time.sleep(0.3)
    return False


def is_logged_in(page: Page) -> bool:
    """Heuristic: visible Sign-in CTA = NOT logged in."""
    try:
        for sel in [
            'a:has-text("Sign in")',
            'button:has-text("Sign in")',
            'a:has-text("Log in")',
            'button:has-text("Log in")',
            '[data-testid*="login"]',
            '[data-testid*="signin"]',
        ]:
            loc = page.locator(sel).first
            if loc.count() > 0 and loc.is_visible():
                return False
    except Exception:
        pass
    return True


def google_sso_login(page: Page, email: str, password: str) -> None:
    """Run Google SSO email+password — assumes we're already on accounts.google.com
    (after clicking some service's 'Continue with Google' / 'Sign in')."""
    deadline = time.time() + 180

    def body():
        try:
            return (page.evaluate("() => document.body.innerText.slice(0, 1200)") or "").lower()
        except Exception:
            return ""

    def check_blockers():
        b = body()
        if "couldn't sign you in" in b or "browser or app may not be secure" in b:
            raise RuntimeError("Google blocked sign-in (browser not secure)")
        if "verify it's you" in b or "verify it is you" in b:
            raise RuntimeError("Google asking for identity verification")
        if "2-step" in b or "verification code" in b:
            raise RuntimeError("Google requires 2FA")
        if "wrong password" in b or "incorrect password" in b:
            raise RuntimeError("Google rejected the password")

    # Email page
    print("[login] waiting for Google email page...")
    while time.time() < deadline:
        check_blockers()
        try:
            if page.locator('input[type="email"]').count() > 0:
                break
            if page.locator('input[type="password"]').count() > 0:
                break  # already past email step
        except Exception:
            pass
        time.sleep(0.4)

    if page.locator('input[type="email"]').count() > 0:
        time.sleep(1.0)
        print(f"[login] entering email: {email}")
        page.locator('input[type="email"]').first.fill(email, timeout=15_000)
        time.sleep(0.6)
        page.keyboard.press("Enter")

    # Password page
    print("[login] waiting for password page...")
    while time.time() < deadline:
        check_blockers()
        if page.locator('input[type="password"]').count() > 0:
            break
        time.sleep(0.4)

    time.sleep(1.5)
    print("[login] entering password")
    page.locator('input[type="password"]').first.fill(password, timeout=15_000)
    time.sleep(0.6)
    page.keyboard.press("Enter")

    # Wait for redirect back to labs.google
    print("[login] waiting for labs.google redirect...")
    while time.time() < deadline:
        h = host_of(page.url)
        if h.endswith("labs.google") or h.endswith("google.com") and "labs" in (page.url or ""):
            time.sleep(3)
            return
        if "accounts.google.com" in (page.url or ""):
            check_blockers()
        time.sleep(1.0)
    raise RuntimeError(f"login: timed out. Last URL: {page.url}")


def main() -> None:
    if not EMAIL or not PASSWORD:
        print("[probe] FLOW_EMAIL / FLOW_PASSWORD missing in .env")
        sys.exit(1)

    pw = sync_playwright().start()
    browser = pw.chromium.connect_over_cdp(f"http://127.0.0.1:{CDP_PORT}")
    if not browser.contexts:
        print("[probe] no browser contexts — flow_keepalive not running?")
        sys.exit(1)
    ctx = browser.contexts[0]

    # Find or open the Flow tab
    page = None
    for p in ctx.pages:
        if "labs.google" in (p.url or "") or "google.com" in (p.url or ""):
            page = p
            break
    if page is None:
        page = ctx.new_page()

    print(f"[probe] starting from current url: {page.url[:120]}")

    # State machine: keep advancing until we're on the Flow editor (logged in).
    max_iterations = 6
    for it in range(max_iterations):
        h = host_of(page.url)
        url = page.url or ""
        print(f"[probe] iter {it}: host={h}")

        if "google.com" in h and "labs" not in h:
            # On Google sign-in
            print("[probe] running Google SSO")
            google_sso_login(page, EMAIL, PASSWORD)
            print("[probe] SSO returned, waiting for redirect back to labs.google")
            d = time.time() + 30
            while time.time() < d:
                if "labs.google" in (page.url or ""):
                    break
                time.sleep(1)
            time.sleep(6)
            continue

        if h.endswith("labs.google"):
            # On labs.google: marketing OR editor. Check for editor markers.
            try:
                page.wait_for_load_state("domcontentloaded", timeout=10_000)
            except Exception:
                pass
            time.sleep(2)

            # Editor markers: contenteditable / textarea / large workspace
            has_editor = page.evaluate("""() => {
                if (document.querySelector('div[contenteditable=true], textarea[placeholder*="prompt" i], textarea[placeholder*="describe" i]')) return true;
                if (document.querySelector('[data-testid*="prompt"], [data-testid*="composer"]')) return true;
                if (document.querySelectorAll('button').length > 30 && /flow|project|new project|model|generate/i.test(document.body.innerText.slice(0,2000))) return true;
                return false;
            }""")
            if has_editor:
                print("[probe] editor surface detected")
                break

            # Marketing page — click Create with Flow and wait for navigation
            print("[probe] marketing page, clicking 'Create with Flow'")
            try:
                with page.expect_navigation(timeout=30_000, wait_until="commit"):
                    if not click_first(page, [
                        'button:has-text("Create with Flow")',
                        'a:has-text("Get Started")',
                        'button:has-text("Get Started")',
                    ], timeout_ms=10_000):
                        raise RuntimeError("entry CTA not found")
            except Exception as e:
                print(f"[probe] navigation wait timed out (normal if Google takes long): {e}")
            time.sleep(5)
            continue

        # Unknown host — sleep and retry
        print(f"[probe] unknown state, host={h}, sleeping")
        time.sleep(5)
    else:
        print("[probe] WARNING: state machine maxed out, dumping anyway")

    print(f"\n[probe] final url: {page.url[:120]}")
    print(f"[probe] title: {page.title()!r}\n")

    # ── Dump UI: buttons, inputs, links, anything actionable ──
    print("─── BUTTONS / LINKS / ROLE=BUTTON ───")
    items = page.evaluate("""() => {
        const out = [];
        for (const sel of ['button', 'a', '[role=button]', '[role=combobox]', '[role=tab]']) {
            for (const el of document.querySelectorAll(sel)) {
                const r = el.getBoundingClientRect();
                if (r.width === 0 || r.height === 0) continue;
                out.push({
                    tag: el.tagName,
                    role: el.getAttribute('role') || '',
                    aria: el.getAttribute('aria-label') || '',
                    href: (el.getAttribute('href') || '').slice(0, 50),
                    testid: el.getAttribute('data-testid') || '',
                    text: (el.innerText || el.textContent || '').slice(0, 60).replace(/\\s+/g, ' ').trim(),
                });
            }
        }
        return out;
    }""")
    for i, it in enumerate(items[:60]):
        print(f"  [{i:2}] {it['tag']:6} role={it['role']:8} testid={it['testid'][:25]!r:27} aria={it['aria'][:30]!r:32} text={it['text']!r}")

    print("\n─── INPUTS / TEXTAREAS / CONTENTEDITABLES ───")
    inputs = page.evaluate("""() => {
        const out = [];
        for (const sel of ['input', 'textarea', '[contenteditable=true]']) {
            for (const el of document.querySelectorAll(sel)) {
                const r = el.getBoundingClientRect();
                if (r.width === 0 || r.height === 0) continue;
                out.push({
                    tag: el.tagName,
                    type: el.getAttribute('type') || '',
                    name: el.getAttribute('name') || '',
                    placeholder: el.getAttribute('placeholder') || '',
                    aria: el.getAttribute('aria-label') || '',
                    testid: el.getAttribute('data-testid') || '',
                });
            }
        }
        return out;
    }""")
    for i, it in enumerate(inputs[:30]):
        print(f"  [{i:2}] {it['tag']:9} type={it['type']:8} placeholder={it['placeholder'][:40]!r:42} aria={it['aria'][:30]!r:32}")

    print("\n─── TEXT MATCHES FOR 'nano' / 'banana' / 'imagen' / 'veo' / 'generate' ───")
    matches = page.evaluate("""() => {
        const out = [];
        const re = /\\b(nano|banana|imagen|veo|generate|create|new\\s+image|new\\s+project|model)\\b/i;
        for (const el of document.querySelectorAll('*')) {
            const t = (el.innerText || '').slice(0, 60).trim();
            if (!t || t.length < 2 || t.length > 60) continue;
            if (!re.test(t)) continue;
            const r = el.getBoundingClientRect();
            if (r.width === 0 || r.height === 0) continue;
            out.push({
                tag: el.tagName,
                aria: el.getAttribute('aria-label') || '',
                testid: el.getAttribute('data-testid') || '',
                text: t.replace(/\\s+/g, ' '),
            });
        }
        return out.slice(0, 30);
    }""")
    for i, it in enumerate(matches):
        print(f"  [{i:2}] {it['tag']:6} testid={it['testid'][:20]!r:22} aria={it['aria'][:25]!r:27} text={it['text']!r}")


if __name__ == "__main__":
    main()
