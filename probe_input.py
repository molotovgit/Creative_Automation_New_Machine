"""Find the actual prompt input element on the Flow canvas."""
import sys, os, time
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
        print("no project tab"); sys.exit(1)
    p.bring_to_front()
    print(f"URL: {p.url[:140]}\n")

    # Find ALL inputs / textareas / contenteditables, then for each find ancestor context
    items = p.evaluate(r"""() => {
        const out = [];
        const selectors = ['input', 'textarea', '[contenteditable=true]', '[role=textbox]'];
        for (const sel of selectors) {
            for (const el of document.querySelectorAll(sel)) {
                const r = el.getBoundingClientRect();
                if (r.width === 0 || r.height === 0) continue;
                // Get a path of nearby parent classes / ancestors with text
                let nearbyText = '';
                let cur = el;
                for (let i = 0; i < 5 && cur; i++) {
                    const t = (cur.textContent || '').slice(0, 80).trim();
                    if (t && t !== nearbyText) nearbyText = t;
                    cur = cur.parentElement;
                }
                out.push({
                    tag: el.tagName,
                    type: el.getAttribute('type') || '',
                    contenteditable: el.getAttribute('contenteditable') || '',
                    role: el.getAttribute('role') || '',
                    aria: el.getAttribute('aria-label') || '',
                    placeholder: el.getAttribute('placeholder') || '',
                    name: el.getAttribute('name') || '',
                    id: el.id || '',
                    class: (el.className || '').slice(0, 80),
                    rect: `${Math.round(r.left)},${Math.round(r.top)}  ${Math.round(r.width)}x${Math.round(r.height)}`,
                    parentText: nearbyText.slice(0, 80),
                });
            }
        }
        return out;
    }""")
    print(f"--- All inputs/contenteditables ({len(items)}) ---")
    for i, it in enumerate(items):
        print(f"[{i:2}] {it['tag']:9} type={it['type']:8} ce={it['contenteditable']!r:6} role={it['role']:10} aria={it['aria'][:25]!r:27}")
        print(f"     placeholder={it['placeholder'][:40]!r:42} id={it['id'][:20]!r:22}")
        print(f"     rect={it['rect']:25}  parentText={it['parentText']!r}")
        print()
