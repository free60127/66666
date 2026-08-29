"""Re-read selected lesson pages at high resolution and emit candidate lessons."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

from build_lesson_corpus import page_map, parse_lesson, run_ocr


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--pdf", required=True, type=Path)
    parser.add_argument("--book", required=True, type=int, choices=(2, 3))
    parser.add_argument("--lessons", required=True, help="Comma-separated lesson numbers")
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--cache-dir", required=True, type=Path)
    parser.add_argument("--scale", type=float, default=6)
    parser.add_argument("--workers", type=int, default=4)
    parser.add_argument("--threads-per-worker", type=int, default=2)
    parser.add_argument("--max-side-len", type=int, default=8000)
    args = parser.parse_args()

    lessons = [int(item) for item in args.lessons.split(",") if item.strip()]
    mapping = page_map(args.book, 96 if args.book == 2 else 60)
    pages_by_lesson = {
        lesson: [mapping[lesson], mapping[lesson] + 1] if args.book == 3 else [mapping[lesson]]
        for lesson in lessons
    }
    pages = {page for lesson_pages in pages_by_lesson.values() for page in lesson_pages}
    blocks = run_ocr(
        args.pdf,
        pages,
        args.scale,
        args.workers,
        args.threads_per_worker,
        args.cache_dir,
        args.max_side_len,
    )
    parsed = []
    for lesson in lessons:
        parsed.append(parse_lesson(lesson, mapping[lesson], [blocks[p] for p in pages_by_lesson[lesson] if p in blocks], args.book))
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps({"book": args.book, "lessons": parsed}, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"Saved {len(parsed)} candidate lessons to {args.output}")


if __name__ == "__main__":
    main()
