"""Look at what's currently on the Flow canvas — img tags, video tags, blob URLs, etc."""
import sys, os
from dotenv import load_dotenv
from playwright.sync_api import sync_playwright

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")
load_dotenv()
CDP_PORT = int(os.environ.get("FLOW_CDP_PORT", "9223"))

with sync_playwright() as pw:
    browser = pw.chromium.connect_over_cdp(f"http://127.0.0.1:{CDP_PORT}")
    ctx = browser.contexts[0]
    p = next((p for p in ctx.pages if "/project/" in (p.url or "")), None)
    if not p:
        p = next((p for p in ctx.pages if "labs.google" in (p.url or "")), None)
    if not p:
        print("no flow tab"); sys.exit(1)
    print(f"URL: {p.url[:140]}\n")

    info = p.evaluate(r"""() => {
        const out = {imgs: [], videos: [], canvases: 0, divsWithBg: []};
        for (const el of document.querySelectorAll('img')) {
            const r = el.getBoundingClientRect();
            out.imgs.push({src: (el.src || '').slice(0, 140), w: Math.round(r.width), h: Math.round(r.height), alt: el.alt || ''});
        }
        for (const el of document.querySelectorAll('video')) {
            out.videos.push({src: (el.src || '').slice(0, 140), w: Math.round(el.getBoundingClientRect().width)});
        }
        out.canvases = document.querySelectorAll('canvas').length;
        // Look for divs with background-image
        for (const el of document.querySelectorAll('div')) {
            const bg = getComputedStyle(el).backgroundImage;
            if (bg && bg !== 'none' && bg.includes('url(') && !bg.includes('data:image/svg')) {
                const r = el.getBoundingClientRect();
                if (r.width > 100) {
                    out.divsWithBg.push({bg: bg.slice(0, 140), w: Math.round(r.width), h: Math.round(r.height)});
                }
            }
        }
        return out;
    }""")
    print(f"--- IMG ({len(info['imgs'])}) ---")
    for i, it in enumerate(info["imgs"]):
        print(f"  [{i:2}] {it['w']}x{it['h']}  alt={it['alt'][:30]!r:32} src={it['src']!r}")
    print(f"\n--- VIDEO ({len(info['videos'])}) ---")
    for i, it in enumerate(info["videos"]):
        print(f"  [{i:2}] {it['w']}px  src={it['src']!r}")
    print(f"\nCanvases: {info['canvases']}")
    print(f"\n--- DIVS WITH bg-image ({len(info['divsWithBg'])}) ---")
    for i, it in enumerate(info["divsWithBg"][:20]):
        print(f"  [{i:2}] {it['w']}x{it['h']}  bg={it['bg']!r}")
