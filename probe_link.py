"""Inspect the 'Create with Flow' anchor's href and target."""
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
    p = next((p for p in ctx.pages if "labs.google" in (p.url or "")), None)
    if not p:
        print("no labs.google tab"); sys.exit(1)
    print(f"URL: {p.url}\n")
    links = p.evaluate(r"""() => Array.from(document.querySelectorAll('a, button')).filter(el => /create with flow|get started/i.test(el.innerText || '')).map(el => ({
        tag: el.tagName,
        href: el.getAttribute('href') || '',
        target: el.getAttribute('target') || '',
        onclick: el.hasAttribute('onclick') ? 'yes' : 'no',
        text: (el.innerText||'').slice(0,40).trim(),
    }))""")
    for i, l in enumerate(links):
        print(f"  [{i}] {l['tag']:6} href={l['href'][:80]!r:82} target={l['target']:6} onclick={l['onclick']:3} text={l['text']!r}")
