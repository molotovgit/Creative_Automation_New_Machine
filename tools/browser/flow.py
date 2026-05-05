"""Google Labs Flow browser driver.

Connects to flow_keepalive via CDP, navigates to the project canvas,
drives image generation with Nano Banana model, downloads results.

Selectors discovered via probe_state.py:
  - Prompt input: <div contenteditable="true"> with placeholder "What do you want to create?"
  - Model+settings combo: <button> with text "🍌 Nano Banana 2 crop_16_9 x2"
  - Generate (submit) button: <button> with material icon "arrow_forward" and text "Create"
  - New project (on project list): <button> with text "New project"
"""

from __future__ import annotations

import os
import random
import re
import time
from typing import Optional

import httpx
from playwright.sync_api import sync_playwright, BrowserContext, Page


# ─── Human-like interaction helpers (defeats reCAPTCHA Enterprise behavioral scoring) ───
#
# Real users don't move in straight lines, type at constant speed, or click
# the exact center of buttons. Each helper here adds one specific aspect of
# human variability:
#   - Bezier-curved mouse paths through multiple sub-positions
#   - Per-char typing delays with 5% "thinking pauses" + punctuation slowdown
#   - Pre-click hover ("looking" at the target before pressing)
#   - Click position jitter so the same button isn't hit pixel-identical twice
#   - Tracked mouse position so subsequent moves curve from the actual origin

# Module-level mouse-position tracker (Playwright doesn't expose it).
_CURRENT_MOUSE: list = [None, None]


def human_delay(min_s: float = 0.8, max_s: float = 2.0) -> None:
    """Random sleep — humans pause inconsistently between actions."""
    time.sleep(random.uniform(min_s, max_s))


def _bezier_points(start: tuple, end: tuple, n: int) -> list:
    """Quadratic Bezier curve points from start to end with a random off-axis control point."""
    sx, sy = start
    ex, ey = end
    dx, dy = ex - sx, ey - sy
    length = max((dx * dx + dy * dy) ** 0.5, 1.0)
    # Perpendicular unit vector
    perp = (-dy / length, dx / length)
    # Place control roughly mid-path, offset perpendicular to give curvature
    mid_t = random.uniform(0.40, 0.60)
    mx = sx + dx * mid_t
    my = sy + dy * mid_t
    offset = length * random.uniform(0.05, 0.20) * random.choice([-1, 1])
    cx = mx + perp[0] * offset
    cy = my + perp[1] * offset
    pts = []
    for i in range(n + 1):
        t = i / n
        x = (1 - t) ** 2 * sx + 2 * (1 - t) * t * cx + t * t * ex
        y = (1 - t) ** 2 * sy + 2 * (1 - t) * t * cy + t * t * ey
        pts.append((x, y))
    return pts


def human_move(page: Page, x: float, y: float, duration_min: float = 0.4, duration_max: float = 1.1) -> None:
    """Move mouse along a curved path with realistic speed (~30-60 fps).

    Uses a quadratic Bezier curve so the trajectory has a slight arc instead
    of a robotic straight line. Slower than instant — duration jitters in
    duration_min..duration_max seconds.
    """
    if _CURRENT_MOUSE[0] is None:
        viewport = page.viewport_size or {"width": 1280, "height": 720}
        _CURRENT_MOUSE[0] = viewport["width"] / 2
        _CURRENT_MOUSE[1] = viewport["height"] / 2

    duration = random.uniform(duration_min, duration_max)
    n_points = max(20, int(duration * 50))  # ~50 fps
    points = _bezier_points((_CURRENT_MOUSE[0], _CURRENT_MOUSE[1]), (x, y), n_points)

    per_step = duration / max(len(points) - 1, 1)
    for px, py in points:
        page.mouse.move(px, py)
        time.sleep(per_step * random.uniform(0.7, 1.3))  # jitter step timing too

    _CURRENT_MOUSE[0] = x
    _CURRENT_MOUSE[1] = y


def human_click(page: Page, x: float, y: float, jitter_px: int = 8) -> None:
    """Hover near target (overshoot + settle), pause to 'look', then click.

    Three sub-steps:
      1. Approach with deliberate overshoot (humans rarely land on first try)
      2. Settle to actual click point with a tiny correction move
      3. Press with realistic mouse-down duration (80-220ms)
    """
    # Approach with slight overshoot
    over_x = x + random.uniform(-jitter_px * 2, jitter_px * 2)
    over_y = y + random.uniform(-jitter_px * 2, jitter_px * 2)
    human_move(page, over_x, over_y)

    # Brief look-pause (eyes-on-target before pressing)
    time.sleep(random.uniform(0.18, 0.45))

    # Small correction move to actual click point
    final_x = x + random.uniform(-jitter_px, jitter_px)
    final_y = y + random.uniform(-jitter_px, jitter_px)
    page.mouse.move(final_x, final_y, steps=random.randint(6, 14))
    _CURRENT_MOUSE[0] = final_x
    _CURRENT_MOUSE[1] = final_y

    time.sleep(random.uniform(0.05, 0.15))
    page.mouse.click(final_x, final_y, delay=random.randint(80, 220))


def human_type(page: Page, text: str) -> None:
    """Type with realistic per-keystroke jitter + 5% thinking pauses + punctuation slowdown.

    Average ~80ms/char base. For a 400-char prompt: ~30s typing + occasional pauses.
    """
    for ch in text:
        page.keyboard.type(ch)
        # Base inter-key delay
        delay_ms = random.uniform(45, 130)
        # 5% chance of a "thinking" pause
        if random.random() < 0.05:
            delay_ms = random.uniform(450, 1300)
        # Slow down on punctuation
        if ch in ".,!?:;":
            delay_ms = max(delay_ms, random.uniform(180, 380))
        elif ch == " ":
            delay_ms = max(delay_ms, random.uniform(80, 200))
        time.sleep(delay_ms / 1000.0)


def human_scroll(page: Page) -> None:
    """Small random vertical scroll — idle filler activity."""
    delta = random.choice([-220, -120, -60, 60, 120, 220])
    try:
        page.mouse.wheel(0, delta)
    except Exception:
        pass


def warm_up(page: Page) -> None:
    """Idle mouse + scroll activity before the first real interaction.

    Real users land on a page and look around for several seconds before
    clicking anything. This generates that signal for behavioral scoring.
    """
    viewport = page.viewport_size or {"width": 1280, "height": 720}
    n_moves = random.randint(3, 6)
    for _ in range(n_moves):
        x = random.randint(150, max(151, viewport["width"] - 150))
        y = random.randint(150, max(151, viewport["height"] - 150))
        human_move(page, x, y)
        human_delay(0.3, 1.2)
        if random.random() < 0.35:
            human_scroll(page)
            human_delay(0.5, 1.5)
    human_delay(1.0, 2.5)


FLOW_URL = "https://labs.google/fx/tools/flow"


def _cdp_get(port: int, path: str = "/json") -> list:
    try:
        return httpx.get(f"http://127.0.0.1:{port}{path}", timeout=5).json()
    except Exception:
        return []


def close_intercept_tabs(cdp_port: int) -> int:
    """Close chrome:// dialogs (managed-user-profile-notice, dice-intercept) that
    can hijack focus mid-automation. Returns count closed."""
    closed = 0
    for t in _cdp_get(cdp_port):
        url = t.get("url", "")
        if (
            url.startswith("chrome://")
            or "managed-user-profile-notice" in url
            or "signin-dice" in url
        ):
            try:
                httpx.put(f"http://127.0.0.1:{cdp_port}/json/close/{t['id']}", timeout=5)
                closed += 1
            except Exception:
                pass
    return closed


def attach_to_keepalive(cdp_port: int):
    pw = sync_playwright().start()
    browser = pw.chromium.connect_over_cdp(f"http://127.0.0.1:{cdp_port}")
    if not browser.contexts:
        raise RuntimeError(f"connected to :{cdp_port} but no contexts found")
    return browser, browser.contexts[0]


def get_flow_page(context: BrowserContext) -> Page:
    """Find the most-progressed Flow tab.

    Order: project canvas > /fx/tools/flow > labs.google > new tab.
    """
    # Prefer a project URL (already in canvas)
    for p in context.pages:
        try:
            if "/fx/tools/flow/project/" in (p.url or ""):
                p.bring_to_front()
                return p
        except Exception:
            continue
    # Then /fx/tools/flow (project list)
    for p in context.pages:
        try:
            if "/fx/tools/flow" in (p.url or ""):
                p.bring_to_front()
                return p
        except Exception:
            continue
    # Any labs.google
    for p in context.pages:
        try:
            if "labs.google" in (p.url or ""):
                p.bring_to_front()
                return p
        except Exception:
            continue
    # Open fresh
    p = context.new_page()
    p.goto(FLOW_URL, wait_until="commit", timeout=60_000)
    return p


def ensure_in_canvas(page: Page, cdp_port: int, timeout_s: int = 90) -> Page:
    """Get to a Flow project canvas. Returns the page that's actually on the canvas
    (may differ from the input page if 'Create with Flow' opened a new tab).

    Click flow:
      - /flow/about      → human-click 'Create with Flow' (opens new tab)
      - /fx/tools/flow   → human-click 'New project'
      - /project/<id>    → done
    """
    deadline = time.time() + timeout_s
    context = page.context

    def _best_page() -> Page:
        # Prefer canvas, then list, then about, then the input page
        for p in context.pages:
            if "/fx/tools/flow/project/" in (p.url or ""):
                return p
        for p in context.pages:
            u = p.url or ""
            if "/fx/tools/flow" in u and "/about" not in u:
                return p
        for p in context.pages:
            if "labs.google" in (p.url or ""):
                return p
        return page

    while time.time() < deadline:
        close_intercept_tabs(cdp_port)
        cur = _best_page()
        cur.bring_to_front()
        try:
            cur.wait_for_load_state("domcontentloaded", timeout=8_000)
        except Exception:
            pass
        url = cur.url or ""

        if "/fx/tools/flow/project/" in url:
            time.sleep(2)
            return cur

        # On /about marketing → click Create with Flow (humanly)
        if "/flow/about" in url:
            bbox = _bbox_of_first_visible(cur, 'a:has-text("Create with Flow"), button:has-text("Create with Flow")')
            if bbox:
                print(f"[gen] human-clicking 'Create with Flow' at ({int(bbox['x'])}, {int(bbox['y'])})")
                human_click(cur, bbox["x"] + bbox["w"] / 2, bbox["y"] + bbox["h"] / 2)
                human_delay(3.0, 6.0)
            close_intercept_tabs(cdp_port)
            continue

        # On /fx/tools/flow project list → click New project (humanly)
        if "/fx/tools/flow" in url and "/project/" not in url:
            bbox = _bbox_of_first_visible(cur, 'button:has-text("New project")')
            if bbox:
                print(f"[gen] human-clicking 'New project' at ({int(bbox['x'])}, {int(bbox['y'])})")
                human_click(cur, bbox["x"] + bbox["w"] / 2, bbox["y"] + bbox["h"] / 2)
                human_delay(3.0, 6.0)
            close_intercept_tabs(cdp_port)
            continue

        # Unknown state — wait and re-evaluate
        time.sleep(2)

    raise RuntimeError(f"failed to enter Flow editor canvas after {timeout_s}s. Last url: {cur.url}")


def _bbox_of_first_visible(page: Page, selector: str) -> Optional[dict]:
    """Return {x, y, w, h} of the first visible element matching selector, or None.

    Uses Playwright's locator API so the selector can include extended syntax
    like :has-text(), :visible, comma-separated alternatives, etc.
    """
    try:
        loc = page.locator(selector)
        n = loc.count()
    except Exception:
        return None
    if n == 0:
        return None
    for i in range(min(n, 20)):
        try:
            el = loc.nth(i)
            if not el.is_visible(timeout=500):
                continue
            box = el.bounding_box(timeout=500)
            if box and box.get("width", 0) > 0 and box.get("height", 0) > 0:
                return {"x": box["x"], "y": box["y"], "w": box["width"], "h": box["height"]}
        except Exception:
            continue
    return None


def human_fill(page: Page, selector: str, text: str, timeout_s: int = 15) -> None:
    """Find field by selector, human-click it, then human-type the text."""
    deadline = time.time() + timeout_s
    bbox = None
    while time.time() < deadline:
        bbox = _bbox_of_first_visible(page, selector)
        if bbox:
            break
        time.sleep(0.4)
    if not bbox:
        raise RuntimeError(f"field not found within {timeout_s}s: {selector}")

    cx = bbox["x"] + bbox["w"] / 2
    cy = bbox["y"] + bbox["h"] / 2
    human_click(page, cx, cy)
    human_delay(0.5, 1.2)
    human_type(page, text)


def _host(url: str) -> str:
    from urllib.parse import urlparse as _u
    try:
        return (_u(url or "").hostname or "").lower()
    except Exception:
        return ""


def login_via_google_human(page: Page, email: str, password: str, cdp_port: int,
                           timeout_s: int = 240) -> Page:
    """Full Google SSO flow with slow curved-mouse + jittered typing.

    Re-finds the best tab after each navigation step — 'Create with Flow' opens
    a NEW tab for the OAuth flow, so we can't keep working on the original
    /about tab. Returns the final page (typically the editor canvas).

    State-aware:
      - on labs.google marketing → click Create with Flow / Sign in (opens new tab)
      - on accounts.google.com → fill email + password
      - waits for redirect back to labs.google, closing any chrome:// intercept tabs

    Raises RuntimeError on timeout or detectable bot-block.
    """
    deadline = time.time() + timeout_s
    context = page.context

    def _pick_best_page() -> Page:
        """Find the most-progressed page across all tabs."""
        # Editor canvas wins
        for p in context.pages:
            if "/fx/tools/flow/project/" in (p.url or ""):
                return p
        # Then Google sign-in (mid-flow)
        for p in context.pages:
            host = _host(p.url)
            if "google.com" in host and not host.endswith("labs.google"):
                return p
        # Then any flow editor / list (post-redirect)
        for p in context.pages:
            u = p.url or ""
            if "/fx/tools/flow" in u and "/about" not in u:
                return p
        # Then any labs.google
        for p in context.pages:
            if "labs.google" in (p.url or ""):
                return p
        return page

    def _check_blockers(p: Page):
        try:
            body = (p.evaluate("() => document.body.innerText.slice(0, 1000)") or "").lower()
        except Exception:
            return
        if "couldn't sign you in" in body or "this browser or app may not be secure" in body:
            raise RuntimeError("Google blocked sign-in: 'browser not secure' (bot detection still tripping)")
        if "verify it's you" in body or "verify it is you" in body:
            raise RuntimeError("Google asking for identity verification — manual step needed once")
        if "2-step" in body or "verification code" in body or "enter the code" in body:
            raise RuntimeError("Google requires 2FA — disable on the test account or solve manually")
        if "wrong password" in body or "incorrect password" in body:
            raise RuntimeError("Google rejected the password")

    # ── Phase 1: trigger OAuth from labs.google ──
    cur = _pick_best_page()
    cur.bring_to_front()
    h = _host(cur.url)
    print(f"[login] starting host: {h}, url: {cur.url[:80]}")

    if h.endswith("labs.google") and "/project/" not in (cur.url or ""):
        for sel in [
            'a:has-text("Create with Flow")',
            'button:has-text("Create with Flow")',
            'a:has-text("Sign in")',
            'button:has-text("Sign in")',
            'a:has-text("Log in")',
            'button:has-text("Log in")',
            'button[data-testid="login-button"]',
        ]:
            bbox = _bbox_of_first_visible(cur, sel)
            if bbox:
                print(f"[login] human-clicking entry CTA ({sel}) at ({int(bbox['x'])}, {int(bbox['y'])})")
                human_click(cur, bbox["x"] + bbox["w"] / 2, bbox["y"] + bbox["h"] / 2)
                human_delay(2.5, 4.5)
                break

        # Wait for a NEW tab to appear on Google sign-in OR for the editor canvas
        print("[login] waiting for Google sign-in tab to open...")
        nav_end = time.time() + 40
        while time.time() < nav_end:
            close_intercept_tabs(cdp_port)
            cur = _pick_best_page()
            cur.bring_to_front()
            if "/fx/tools/flow/project/" in (cur.url or ""):
                print(f"[login] success — landed in editor (cookies were present): {cur.url[:80]}")
                return cur
            host = _host(cur.url)
            if "google.com" in host and not host.endswith("labs.google"):
                print(f"[login] reached Google sign-in: {cur.url[:80]}")
                break
            time.sleep(1)

    # ── Phase 2: fill email ──
    cur = _pick_best_page()
    cur.bring_to_front()
    h = _host(cur.url)
    if "google.com" in h and not h.endswith("labs.google"):
        print(f"[login] entering email (slowly): {email}")
        _check_blockers(cur)
        human_fill(cur, 'input[type="email"]', email, timeout_s=20)
        human_delay(1.5, 3.0)

        next_bbox = _bbox_of_first_visible(cur, '#identifierNext button, button:has-text("Next")')
        if next_bbox:
            print(f"[login] clicking Next button (after email)")
            human_click(cur, next_bbox["x"] + next_bbox["w"] / 2, next_bbox["y"] + next_bbox["h"] / 2)
        else:
            cur.keyboard.press("Enter")
        human_delay(2.5, 4.5)

    # ── Phase 3: fill password ──
    cur = _pick_best_page()
    cur.bring_to_front()
    pw_deadline = time.time() + 30
    pw_bbox = None
    while time.time() < pw_deadline and time.time() < deadline:
        _check_blockers(cur)
        pw_bbox = _bbox_of_first_visible(cur, 'input[type="password"]')
        if pw_bbox:
            break
        time.sleep(0.6)
    if not pw_bbox:
        raise RuntimeError(f"password field never appeared. Last URL: {cur.url}")

    print("[login] entering password (slowly)")
    human_delay(1.0, 2.2)
    human_click(cur, pw_bbox["x"] + pw_bbox["w"] / 2, pw_bbox["y"] + pw_bbox["h"] / 2)
    human_delay(0.6, 1.4)
    human_type(cur, password)
    human_delay(1.5, 3.0)

    next_bbox = _bbox_of_first_visible(cur, '#passwordNext button, button:has-text("Next")')
    if next_bbox:
        print(f"[login] clicking Next button (after password)")
        human_click(cur, next_bbox["x"] + next_bbox["w"] / 2, next_bbox["y"] + next_bbox["h"] / 2)
    else:
        cur.keyboard.press("Enter")

    # ── Phase 4: wait for redirect back to labs.google ──
    print("[login] waiting for redirect to labs.google...")
    while time.time() < deadline:
        close_intercept_tabs(cdp_port)
        cur = _pick_best_page()
        cur.bring_to_front()
        h = _host(cur.url)
        if h.endswith("labs.google"):
            time.sleep(3)
            print(f"[login] success — back on labs.google: {cur.url[:80]}")
            return cur
        if "google.com" in h:
            _check_blockers(cur)
        time.sleep(1)

    raise RuntimeError(f"login timed out waiting for labs.google redirect. Last URL: {cur.url}")


def is_signed_in_to_flow(page: Page) -> bool:
    """URL-based signed-in detection.

    Marketing /about page contains words like 'Ultra' / 'credits' even when
    logged out, so don't body-text-match. Trust the URL:
      - /fx/tools/flow/project/<id> → in editor canvas → signed in
      - /fx/tools/flow (project list, not /about) → signed in
      - anything else → unknown / not signed in
    """
    url = page.url or ""
    if "/fx/tools/flow/project/" in url:
        return True
    if "/fx/tools/flow" in url and "/about" not in url:
        return True
    return False


def ensure_logged_in_human(page: Page, email: str, password: str, cdp_port: int) -> Page:
    """If not signed in, run the human SSO flow. Returns the page that's now signed in."""
    if is_signed_in_to_flow(page):
        print("[login] already signed in — skip")
        return page
    print(f"[login] not signed in — running human SSO as {email}")
    return login_via_google_human(page, email, password, cdp_port)


def select_count_one(page: Page) -> None:
    """Open the model+settings popup and switch x2 → x1 (one image per prompt).

    Best effort — if we can't find the count toggle, leave default.
    """
    # The combo button has text like "🍌 Nano Banana 2 crop_16_9 x2"
    btn = page.locator('button:has-text("Nano Banana")').first
    if btn.count() == 0:
        return

    # Skip if already showing "x1"
    try:
        if "x1" in (btn.text_content() or ""):
            return
    except Exception:
        pass

    try:
        btn.click(timeout=5000)
        time.sleep(1.5)
    except Exception:
        return

    # Look for "1" option in the popup. Try multiple selectors.
    for sel in [
        'button:has-text("x1")',
        '[role=menuitem]:has-text("1")',
        'button:has-text("1") >> visible=true',
        'div:has-text("1 image"):visible',
    ]:
        try:
            opt = page.locator(sel).first
            if opt.count() > 0 and opt.is_visible():
                opt.click(timeout=3000)
                time.sleep(0.8)
                # Close popup if still open (Esc)
                page.keyboard.press("Escape")
                time.sleep(0.5)
                return
        except Exception:
            continue
    # Couldn't change — close popup
    page.keyboard.press("Escape")
    time.sleep(0.5)


def fill_prompt(page: Page, prompt_text: str) -> None:
    """Find the visible prompt editor, mouse-click it, clear, and human-type the prompt.

    Uses real mouse + keyboard events (no execCommand) so the keystroke pattern
    matches a human typing — important for reCAPTCHA Enterprise scoring.
    """
    # Locate the visible contenteditable + return its bbox center.
    bbox = page.evaluate(r"""() => {
        const els = document.querySelectorAll('div[contenteditable="true"][role="textbox"]');
        for (const el of els) {
            const r = el.getBoundingClientRect();
            if (r.width > 100 && r.height > 0) {
                return {x: r.left, y: r.top, w: r.width, h: r.height};
            }
        }
        return null;
    }""")
    if not bbox:
        raise RuntimeError("prompt editor not found on canvas")

    # Move mouse to the editor and click — real pointer events with curved path
    cx = bbox["x"] + bbox["w"] / 2
    cy = bbox["y"] + bbox["h"] / 2
    human_click(page, cx, cy)

    # Pause to "read" the empty prompt area before typing
    human_delay(0.8, 2.0)

    # Select existing content (if any) and delete it
    page.keyboard.press("Control+a")
    human_delay(0.15, 0.35)
    page.keyboard.press("Delete")
    human_delay(0.3, 0.7)

    # Type with realistic per-keystroke jitter + thinking pauses
    human_type(page, prompt_text)

    # Post-typing read pause (humans review what they wrote before submitting)
    human_delay(1.5, 3.5)


def click_generate(page: Page) -> None:
    """Mouse-click the 'arrow_forward Create' submit button at the right of the prompt bar.

    Avoids the keyboard Enter shortcut (too automation-y) — instead finds the
    actual button bbox and human-clicks it.
    """
    # Get bbox of the rightmost button containing 'arrow_forward' (the submit)
    bbox = page.evaluate(r"""() => {
        const buttons = Array.from(document.querySelectorAll('button')).filter(el => {
            const t = (el.innerText || '').toLowerCase();
            const aria = (el.getAttribute('aria-label') || '').toLowerCase();
            return t.includes('arrow_forward') || aria.includes('create') || aria.includes('submit');
        });
        if (buttons.length === 0) return null;
        // Pick the one furthest right (the submit is at the end of the prompt bar)
        let best = buttons[0];
        let bestX = -Infinity;
        for (const b of buttons) {
            const r = b.getBoundingClientRect();
            if (r.width === 0 || r.height === 0) continue;
            if (r.left > bestX) {
                best = b;
                bestX = r.left;
            }
        }
        const r = best.getBoundingClientRect();
        return {x: r.left, y: r.top, w: r.width, h: r.height};
    }""")
    if not bbox:
        raise RuntimeError("could not locate Generate / Create button")

    cx = bbox["x"] + bbox["w"] / 2
    cy = bbox["y"] + bbox["h"] / 2
    human_click(page, cx, cy)
    human_delay(0.6, 1.4)


def wait_for_new_image(page: Page, baseline_count: int, max_s: int = 120) -> Optional[dict]:
    """Wait until a new generated <img> appears on the canvas.

    Returns {src, alt, idx} for the latest image, or None on timeout.
    """
    deadline = time.time() + max_s
    while time.time() < deadline:
        try:
            data = page.evaluate(r"""() => {
                const imgs = Array.from(document.querySelectorAll('img')).filter(el => {
                    const r = el.getBoundingClientRect();
                    if (r.width < 100 || r.height < 100) return false;
                    const src = el.src || '';
                    // Filter out icons / avatars (small or well-known)
                    if (src.startsWith('data:image/svg')) return false;
                    if (/(logo|icon|avatar|banner|emoji)/i.test(src)) return false;
                    return true;
                });
                return {
                    count: imgs.length,
                    last: imgs.length ? {src: imgs[imgs.length-1].src, alt: imgs[imgs.length-1].alt} : null,
                };
            }""")
            if data["count"] > baseline_count and data["last"] and data["last"]["src"]:
                return {"src": data["last"]["src"], "alt": data["last"]["alt"]}
        except Exception:
            pass
        time.sleep(2)
    return None


def count_canvas_images(page: Page) -> int:
    """Baseline image count on the canvas — used to detect new ones."""
    try:
        return page.evaluate(r"""() => Array.from(document.querySelectorAll('img')).filter(el => {
            const r = el.getBoundingClientRect();
            if (r.width < 100 || r.height < 100) return false;
            const src = el.src || '';
            if (src.startsWith('data:image/svg')) return false;
            if (/(logo|icon|avatar|banner|emoji)/i.test(src)) return false;
            return true;
        }).length""")
    except Exception:
        return 0


def download_image(page: Page, image_url: str, save_path) -> bool:
    """Download an image by its URL using the page's authenticated context.

    Uses page.request which carries the session cookies — required because
    Flow's image URLs are typically signed/auth-gated.
    """
    try:
        response = page.request.get(image_url, timeout=60_000)
        if response.status != 200:
            return False
        save_path.parent.mkdir(parents=True, exist_ok=True)
        save_path.write_bytes(response.body())
        return True
    except Exception:
        return False
