"""Navigate to the Flow editor (clicking through CTAs + closing intercept tabs)
and dump the actual editor UI so we can identify selectors for the generator."""

import sys
import time
import os
import httpx
from dotenv import load_dotenv
from playwright.sync_api import sync_playwright

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")
load_dotenv()
CDP_PORT = int(os.environ.get("FLOW_CDP_PORT", "9223"))


def list_targets():
    try:
        return httpx.get(f"http://127.0.0.1:{CDP_PORT}/json", timeout=5).json()
    except Exception:
        return []


def close_intercept_tabs():
    """Close chrome:// dialogs that block automation. Returns count closed."""
    closed = 0
    for t in list_targets():
        url = t.get("url", "")
        if url.startswith("chrome://") or "managed-user-profile-notice" in url or "signin-dice" in url:
            try:
                httpx.put(f"http://127.0.0.1:{CDP_PORT}/json/close/{t['id']}", timeout=5)
                closed += 1
            except Exception:
                pass
    return closed


def main():
    # Pre-clean any intercept tabs
    n = close_intercept_tabs()
    if n:
        print(f"[probe] closed {n} intercept tab(s)")
        time.sleep(2)

    with sync_playwright() as pw:
        browser = pw.chromium.connect_over_cdp(f"http://127.0.0.1:{CDP_PORT}")
        ctx = browser.contexts[0]

        # Prefer the /fx/tools/flow tab (editor URL) over /about (marketing).
        flow_page = None
        # Pass 1: editor URL
        for p in ctx.pages:
            try:
                if "/fx/tools/flow" in (p.url or ""):
                    flow_page = p
                    break
            except Exception:
                continue
        # Pass 2: any labs.google
        if flow_page is None:
            for p in ctx.pages:
                try:
                    if "labs.google" in (p.url or ""):
                        flow_page = p
                        break
                except Exception:
                    continue
        # Pass 3: any google.com (could be on accounts.google.com mid-redirect)
        if flow_page is None:
            for p in ctx.pages:
                try:
                    if "google.com" in (p.url or ""):
                        flow_page = p
                        break
                except Exception:
                    continue
        if flow_page is None:
            print("[probe] no relevant tab")
            sys.exit(1)

        flow_page.bring_to_front()
        print(f"[probe] starting at: {flow_page.url[:140]}")
        try:
            flow_page.wait_for_load_state("domcontentloaded", timeout=15_000)
        except Exception:
            pass
        time.sleep(3)

        # Check page state
        body_text = ""
        try:
            body_text = (flow_page.evaluate("() => document.body.innerText") or "")[:1500].lower()
        except Exception:
            pass

        # If on /about marketing, click Create with Flow (opens new tab usually)
        if "/about" in flow_page.url:
            print("[probe] on marketing /about — clicking 'Create with Flow'")
            try:
                flow_page.locator('a:has-text("Create with Flow")').first.click(timeout=10_000)
            except Exception as e:
                print(f"[probe] click failed: {e}")
            time.sleep(8)
            close_intercept_tabs()

        # Re-find best tab
        for p in ctx.pages:
            try:
                if "/fx/tools/flow" in (p.url or "") or ("/project/" in (p.url or "")):
                    flow_page = p
                    break
            except Exception:
                continue
        flow_page.bring_to_front()
        try:
            flow_page.wait_for_load_state("domcontentloaded", timeout=15_000)
        except Exception:
            pass
        time.sleep(3)

        # If on project list (sees "New project" button), click it
        try:
            body_text = (flow_page.evaluate("() => document.body.innerText") or "")[:2000].lower()
        except Exception:
            body_text = ""
        on_project_list = "new project" in body_text and "/project/" not in flow_page.url

        if on_project_list:
            print("[probe] on project list — clicking 'New project'")
            try:
                flow_page.locator('button:has-text("New project")').first.click(timeout=10_000)
            except Exception as e:
                try:
                    # Fallback: click any element with text "New project"
                    flow_page.locator('text=New project').first.click(timeout=5_000)
                except Exception as e2:
                    print(f"[probe] New project click failed: {e}, {e2}")
            time.sleep(8)
            close_intercept_tabs()

        # Final close + bring to front
        close_intercept_tabs()
        time.sleep(1)
        flow_page.bring_to_front()

        try:
            flow_page.wait_for_load_state("domcontentloaded", timeout=15_000)
        except Exception:
            pass
        time.sleep(3)

        print(f"\n=== Final page ===")
        print(f"URL: {flow_page.url[:140]}")
        try: print(f"Title: {flow_page.title()!r}\n")
        except: pass

        try:
            body = flow_page.evaluate("() => document.body.innerText.slice(0, 2500)")
            print("--- BODY EXCERPT ---")
            print(body)
            print()
        except Exception as e:
            print(f"body eval failed: {e}\n")

        try:
            items = flow_page.evaluate(r"""() => {
                const out = [];
                for (const el of document.querySelectorAll('button, a, [role=button], [role=tab], [role=combobox], textarea, input, [contenteditable=true]')) {
                    const r = el.getBoundingClientRect();
                    if (r.width === 0 || r.height === 0) continue;
                    out.push({
                        tag: el.tagName,
                        type: el.getAttribute('type') || '',
                        aria: el.getAttribute('aria-label') || '',
                        placeholder: el.getAttribute('placeholder') || '',
                        testid: el.getAttribute('data-testid') || '',
                        text: (el.innerText || el.textContent || '').slice(0, 80).replace(/\s+/g, ' ').trim(),
                    });
                }
                return out.slice(0, 80);
            }""")
            print("--- ACTIONABLE ELEMENTS ---")
            for i, it in enumerate(items):
                print(f"  [{i:2}] {it['tag']:9} type={it['type']:6} testid={it['testid'][:18]!r:20} aria={it['aria'][:25]!r:27} ph={it['placeholder'][:25]!r:27} text={it['text']!r}")
        except Exception as e:
            print(f"button eval failed: {e}")


if __name__ == "__main__":
    main()
