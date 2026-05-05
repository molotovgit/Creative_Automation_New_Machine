"""Step 4 — generate one image per prompt via Flow Nano Banana.

Reads prompts/{g}-{lang}/{subject}/{basename}.json (80 entries), drives
labs.google/fx/tools/flow to generate ONE image per prompt with Nano Banana,
saves results to images/{g}-{lang}/{subject}/{basename}/{idx:03d}-{slug}.png.

3-second delay between generations.

Usage:
    python generate_images.py --grade 7 --lang uz --subject "jahon tarixi" --chapter 1
    python generate_images.py --input prompts/g7-uz/jahon-tarixi/ch01-...json --limit 1
"""

from __future__ import annotations

import argparse
import json
import os
import random
import re
import sys
import time
from pathlib import Path

from dotenv import load_dotenv

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")

load_dotenv()

REPO = Path(__file__).resolve().parent
sys.path.insert(0, str(REPO))

from tools.browser import flow as fl

CDP_PORT = int(os.environ.get("FLOW_CDP_PORT", "9223"))
# Jittered delay between generations — uniform 8-15s. Constant 3s was too
# bot-like and contributed to reCAPTCHA Enterprise score.
DELAY_MIN_SECONDS = 8
DELAY_MAX_SECONDS = 15
MAX_WAIT_PER_IMAGE_SECONDS = 180
# Probability of an idle scroll between gens (further humanization)
SCROLL_PROBABILITY = 0.3


def slugify(text: str, max_len: int = 60) -> str:
    text = text.lower().strip()
    repl = {"ʼ": "", "'": "", "`": ""}
    for src, dst in repl.items():
        text = text.replace(src, dst)
    text = re.sub(r"[^a-z0-9\s-]", "", text)
    text = re.sub(r"[\s-]+", "-", text).strip("-")
    return text[:max_len].rstrip("-") or "untitled"


def resolve_prompts_file(grade: int, lang: str, subject: str, chapter: int) -> Path:
    subject_slug = slugify(subject)
    folder = REPO / "prompts" / f"g{grade}-{lang}" / subject_slug
    matches = sorted(folder.glob(f"ch{chapter:02d}-*.json"))
    if not matches:
        raise SystemExit(f"No prompts file at {folder}\\ch{chapter:02d}-*.json — run generate_prompts.py first")
    return matches[0]


def main() -> None:
    parser = argparse.ArgumentParser(description="Generate images from prompts.json via Flow Nano Banana.")
    parser.add_argument("--input", type=Path, help="Direct path to the prompts.json")
    parser.add_argument("--grade", type=int)
    parser.add_argument("--lang", default="uz", choices=["uz", "ru"])
    parser.add_argument("--subject")
    parser.add_argument("--chapter", type=int)
    parser.add_argument("--limit", type=int, default=0, help="Generate only the first N prompts (0 = all)")
    parser.add_argument("--start", type=int, default=1, help="Start at idx N (1-indexed)")
    args = parser.parse_args()

    if args.input:
        input_path = args.input.resolve()
    elif args.grade and args.subject and args.chapter:
        input_path = resolve_prompts_file(args.grade, args.lang, args.subject, args.chapter)
    else:
        parser.error("either --input <path> or (--grade, --subject, --chapter) is required")

    if not input_path.exists():
        raise SystemExit(f"prompts file not found: {input_path}")

    prompts = json.loads(input_path.read_text(encoding="utf-8"))
    print(f"[gen] loaded {len(prompts)} prompts from {input_path.name}")

    # Filter by --start and --limit
    prompts = [p for p in prompts if p["idx"] >= args.start]
    if args.limit > 0:
        prompts = prompts[: args.limit]
    print(f"[gen] will generate {len(prompts)} image(s) (start={args.start}, limit={args.limit})")

    # Output: images/g{grade}-{lang}/{subject-slug}/{basename}/
    base = input_path.stem  # ch01-german-qabilalari-va-rim-imperiyasi
    parts = input_path.resolve().parts
    try:
        idx = parts.index("prompts")
    except ValueError:
        raise SystemExit(f"input path missing 'prompts/' segment: {input_path}")
    new_parts = list(parts)
    new_parts[idx] = "images"
    out_dir = Path(*new_parts).parent / base
    out_dir.mkdir(parents=True, exist_ok=True)
    print(f"[gen] output dir: {out_dir}")

    # Connect to Flow keepalive
    print(f"[gen] connecting to Flow keep-alive on :{CDP_PORT}")
    try:
        browser, context = fl.attach_to_keepalive(CDP_PORT)
    except Exception as e:
        raise SystemExit(
            f"[gen] cannot connect to Flow keep-alive: {e}\n"
            f"        Start it: python flow_keepalive.py"
        )

    fl.close_intercept_tabs(CDP_PORT)
    page = fl.get_flow_page(context)
    print(f"[gen] working tab: {page.url[:120]}")

    # Auto-login if needed, using slow human-mimicking interaction
    email = os.environ.get("FLOW_EMAIL", "")
    password = os.environ.get("FLOW_PASSWORD", "")
    if not email or not password:
        raise SystemExit("[gen] FLOW_EMAIL / FLOW_PASSWORD not set in .env")
    try:
        page = fl.ensure_logged_in_human(page, email, password, CDP_PORT)
    except Exception as e:
        raise SystemExit(f"[gen] auto-login failed: {e}")
    page.bring_to_front()

    # Make sure we're on a project canvas (handles marketing → CTA → project list → New project → canvas)
    print("[gen] ensuring we're in a Flow project canvas...")
    page = fl.ensure_in_canvas(page, CDP_PORT)
    page.bring_to_front()
    print(f"[gen] in canvas: {page.url[:120]}")

    # Warm up — idle mouse + scroll activity before any real interaction.
    # Real users land on a page and look around for several seconds before
    # touching anything; this generates that signal for behavioral scoring.
    print("[gen] warming up (idle mouse + scroll, ~10-15s)...")
    fl.warm_up(page)

    # Set count to 1 image per prompt (default is x2)
    print("[gen] attempting to set count = 1 image per prompt")
    try:
        fl.select_count_one(page)
    except Exception as e:
        print(f"[gen] couldn't change count (will continue with default): {e}")

    # Generate loop
    successes, failures = 0, 0
    for entry in prompts:
        idx = entry["idx"]
        slug = entry["slug"]
        prompt_text = entry["image_prompt"]

        out_file = out_dir / f"{idx:03d}-{slug}.png"
        if out_file.exists() and out_file.stat().st_size > 1024:
            print(f"[gen] {idx:03d} skip (already exists)")
            continue

        print(f"\n[gen] {idx:03d}/{len(prompts)} — {slug}")
        try:
            baseline = fl.count_canvas_images(page)
            fl.fill_prompt(page, prompt_text)
            fl.click_generate(page)
            print(f"[gen]   submitted, waiting for image (baseline={baseline})...")

            t0 = time.time()
            result = fl.wait_for_new_image(page, baseline, max_s=MAX_WAIT_PER_IMAGE_SECONDS)
            dt = time.time() - t0

            if not result:
                print(f"[gen]   FAIL: no new image after {MAX_WAIT_PER_IMAGE_SECONDS}s")
                failures += 1
            else:
                ok = fl.download_image(page, result["src"], out_file)
                if ok:
                    print(f"[gen]   OK: {out_file.name} ({out_file.stat().st_size:,} bytes, {dt:.1f}s)")
                    successes += 1
                else:
                    print(f"[gen]   FAIL: download of {result['src'][:100]}")
                    failures += 1
        except Exception as e:
            print(f"[gen]   ERROR: {e}")
            failures += 1

        # Jittered delay before next prompt; occasional idle scroll
        if random.random() < SCROLL_PROBABILITY:
            try:
                fl.human_scroll(page)
            except Exception:
                pass
        wait = random.uniform(DELAY_MIN_SECONDS, DELAY_MAX_SECONDS)
        print(f"[gen]   sleeping {wait:.1f}s before next prompt")
        time.sleep(wait)

    print(f"\n[gen] DONE — {successes} succeeded, {failures} failed")
    print(f"[gen] images saved to: {out_dir}")


if __name__ == "__main__":
    main()
