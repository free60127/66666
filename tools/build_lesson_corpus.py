"""Build a New Concept English lesson corpus from scanned book PDFs.

The source PDFs are image-only. This script uses the already installed
RapidOCR ONNX models, keeps OCR work limited to lesson pages, and emits only
the fields needed by the translation trainer.
"""

from __future__ import annotations

import argparse
import concurrent.futures
import json
import multiprocessing
import os
import re
import sys
from pathlib import Path
from typing import Any


WORKER_DOC = None
WORKER_OCR = None
WORKER_SCALE = 2.0
WORKER_MAX_SIDE_LEN = 4000

TITLE_OVERRIDES = {
    24: ("A skeleton in the cupboard", "家丑"),
    41: ("Illusions of pastoral peace", "宁静田园生活的遐想"),
}


def page_map(book: int, lessons: int) -> dict[int, int]:
    """Return physical PDF pages for the lesson starts in these editions."""
    if book == 3:
        # The printed book inserts unit instruction/review pages before
        # Lessons 21 and 41; the lesson rhythm is four pages within each block.
        blocks = ((1, 20, 16), (21, 40, 108), (41, 60, 194))
        result: dict[int, int] = {}
        for first, last, page in blocks:
            for lesson in range(first, last + 1):
                result[lesson] = page + (lesson - first) * 4
        return result

    # Book 2 contains three unit review sections, hence the four blocks.
    starts = ((1, 24, 15), (25, 48, 125), (49, 72, 235), (73, 96, 345))
    result: dict[int, int] = {}
    for first, last, page in starts:
        for lesson in range(first, last + 1):
            result[lesson] = page + (lesson - first) * 4
    return result


def load_page_map(book: int, lessons: int, source: Path | None) -> dict[int, int]:
    if source and source.exists():
        try:
            data = json.loads(source.read_text(encoding="utf-8"))
            mapped = {
                int(item["lesson"]): int(item["pdf_page"])
                for item in data.get("lessons", [])
                if item.get("lesson") is not None and item.get("pdf_page") is not None
            }
            if len(mapped) == lessons and set(mapped) == set(range(1, lessons + 1)):
                return mapped
        except (OSError, ValueError, TypeError, KeyError):
            pass
    return page_map(book, lessons)


def _pdf_page_count(pdf_path: Path) -> int:
    import pymupdf

    with pymupdf.open(pdf_path) as document:
        return document.page_count


def init_worker(pdf_path: str, scale: float, threads: int, max_side_len: int) -> None:
    global WORKER_DOC, WORKER_OCR, WORKER_SCALE, WORKER_MAX_SIDE_LEN
    import pymupdf
    from rapidocr_onnxruntime import RapidOCR

    WORKER_DOC = pymupdf.open(pdf_path)
    WORKER_SCALE = scale
    WORKER_MAX_SIDE_LEN = max_side_len
    WORKER_OCR = RapidOCR(
        intra_op_num_threads=threads,
        inter_op_num_threads=1,
        max_side_len=max_side_len,
        text_score=0.35,
    )


def ocr_page(page_number: int) -> dict[str, Any]:
    if WORKER_DOC is None or WORKER_OCR is None:
        raise RuntimeError("OCR worker was not initialized")
    page = WORKER_DOC[page_number - 1]
    pix = page.get_pixmap(
        matrix=__import__("pymupdf").Matrix(WORKER_SCALE, WORKER_SCALE),
        alpha=False,
    )
    result, _ = WORKER_OCR(pix.tobytes("png"))
    rows = ocr_rows(result)

    # The body of these scans is easy to read when isolated from the page
    # furniture and illustration. Use the full page for headings and Chinese,
    # then replace the detected lesson-body interval with a second pass.
    title_rows = [row for row in rows if re.search(r"Lesson\s*\d{1,2}", row["text"], re.IGNORECASE)]
    new_words_index = find_marker(rows, ("newwordsandexpressions", "newwords"))
    if title_rows and new_words_index is not None:
        title_y = min(row["y"] for row in title_rows)
        new_words_y = rows[new_words_index]["y"]
        top = max(0.0, (title_y + 90) / WORKER_SCALE)
        bottom = min(page.rect.height, (new_words_y - 15) / WORKER_SCALE)
        if bottom - top > 20:
            clip = __import__("pymupdf").Rect(0, top, page.rect.width, bottom)
            body_pix = page.get_pixmap(
                matrix=__import__("pymupdf").Matrix(WORKER_SCALE, WORKER_SCALE),
                clip=clip,
                alpha=False,
            )
            body_result, _ = WORKER_OCR(body_pix.tobytes("png"))
            body_rows = ocr_rows(body_result, y_offset=round(top * WORKER_SCALE))
            rows = [
                row
                for row in rows
                if not (title_y + 90 <= row["y"] < new_words_y - 10)
            ] + body_rows

        # A scan can produce a low-confidence garbage row where an otherwise
        # clear English line crosses the detector's layout boundary. Re-read
        # only those narrow bands; this is much more reliable than accepting
        # the garbage or rerunning the whole page repeatedly.
        low_rows = [
            row
            for row in rows
            if title_y + 90 <= row["y"] < new_words_y - 10
            and row["score"] < 0.75
            and re.search(r"[A-Za-z]", row["text"])
        ]
        for low_row in low_rows:
            band_top = max(0.0, (low_row["y"] - 36) / WORKER_SCALE)
            band_bottom = min(page.rect.height, (low_row["y"] + 72) / WORKER_SCALE)
            band = __import__("pymupdf").Rect(0, band_top, page.rect.width * 0.96, band_bottom)
            band_pix = page.get_pixmap(
                matrix=__import__("pymupdf").Matrix(WORKER_SCALE, WORKER_SCALE),
                clip=band,
                alpha=False,
            )
            band_result, _ = WORKER_OCR(band_pix.tobytes("png"))
            recovered = [
                row
                for row in ocr_rows(band_result, y_offset=round(band_top * WORKER_SCALE))
                if row["score"] >= 0.75 and re.search(r"[A-Za-z]", row["text"])
            ]
            if recovered:
                rows = [
                    row
                    for row in rows
                    if not (low_row["y"] - 30 <= row["y"] <= low_row["y"] + 30)
                ] + recovered
    rows.sort(key=lambda row: (row["y"], row["x"]))
    return {"page": page_number, "width": pix.width, "height": pix.height, "rows": rows}


def ocr_rows(result: Any, y_offset: int = 0) -> list[dict[str, Any]]:
    rows = []
    for box, text, score in result or []:
        text = str(text).strip()
        if not text:
            continue
        rows.append(
            {
                "y": round(min(point[1] for point in box)) + y_offset,
                "x": round(min(point[0] for point in box)),
                "text": text,
                "score": round(float(score), 4),
            }
        )
    return rows


def latin_text(text: str) -> str:
    text = text.replace("\u2018", "'").replace("\u2019", "'")
    text = text.replace("\u201c", '"').replace("\u201d", '"')
    text = text.replace("\u2013", "-").replace("\u2014", "-")
    text = text.replace("�", "")
    text = text.replace("\u00a0", " ")
    text = re.sub(r"\s+", " ", text).strip()
    text = re.sub(r"\s+([,.!?;:])", r"\1", text)
    text = re.sub(r"([,.!?;:])(?=[A-Za-z])", r"\1 ", text)
    text = re.sub(r"^\d{1,2}\s+(?=[A-Za-z])", "", text)
    return text.strip()


def chinese_text(text: str) -> str:
    text = text.replace("\u00a0", " ")
    text = re.sub(r"\s+", "", text)
    text = re.sub(r"^[0-9]+", "", text)
    return text.strip(" \t\r\n-:：")


def is_cjk(text: str) -> bool:
    return bool(re.search(r"[\u3400-\u9fff]", text))


def compact_marker(text: str) -> str:
    return re.sub(r"[^a-z]", "", text.lower())


def find_title(rows: list[dict[str, Any]], lesson: int) -> tuple[str, str, int | None]:
    # Some scans use "Lesson 1A" without a separator before the title.
    pattern = re.compile(rf"Lesson\s*{lesson}(?=[^0-9]|$)", re.IGNORECASE)
    if lesson == 11:
        pattern = re.compile(r"Lesson\s*1[1lI](?=[^0-9]|$)", re.IGNORECASE)
    for row in rows:
        match = pattern.search(row["text"])
        if not match:
            continue
        remainder = row["text"][match.end() :].strip(" .:-")
        title = re.split(r"[\u3400-\u9fff]", remainder, maxsplit=1)[0].strip(" .:-")
        if not title:
            same_line_titles = [
                candidate
                for candidate in rows
                if abs(candidate["y"] - row["y"]) <= 28
                and candidate["x"] > row["x"]
                and re.search(r"[A-Za-z]", candidate["text"])
                and not pattern.search(candidate["text"])
            ]
            if same_line_titles:
                title = re.split(
                    r"[\u3400-\u9fff]", same_line_titles[0]["text"], maxsplit=1
                )[0].strip(" .:-")
        same_line_cn = re.search(r"[\u3400-\u9fff].*", remainder)
        title_cn = same_line_cn.group(0).strip() if same_line_cn else ""
        title_rows = [
            candidate
            for candidate in rows
            if row["y"] - 40 <= candidate["y"] <= row["y"] + 130
            and is_cjk(candidate["text"])
        ]
        if not title_cn and title_rows:
            title_rows.sort(key=lambda candidate: abs(candidate["y"] - row["y"]))
            cn_match = re.search(r"[\u3400-\u9fff].*", title_rows[0]["text"])
            title_cn = chinese_text(cn_match.group(0) if cn_match else title_rows[0]["text"])
        title = latin_text(title).strip(" '\"")
        title = re.sub(r"^\d+\s+", "", title)
        title = title.replace("lt's", "It's").replace("Cuty Sark", "Cutty Sark")
        title = title.replace("calender", "calendar").rstrip("*").strip()
        return title, chinese_text(title_cn), row["y"]
    return f"Lesson {lesson}", "", None


def find_marker(rows: list[dict[str, Any]], names: tuple[str, ...], after: int = -1) -> int | None:
    for index, row in enumerate(rows):
        if index <= after:
            continue
        marker = compact_marker(row["text"])
        if any(name in marker for name in names):
            return index
    return None


def extract_original(rows: list[dict[str, Any]], lesson: int) -> str:
    _, _, title_y = find_title(rows, lesson)
    if title_y is None:
        return ""
    new_words = find_marker(rows, ("newwordsandexpressions", "newwords"))
    if new_words is None:
        return ""

    before_words = rows[:new_words]
    width = max((row["x"] for row in rows), default=1000)
    article_start = find_article_start(before_words, title_y, width)
    if article_start is None:
        return ""
    body = []
    for row in before_words:
        if row["y"] < article_start or row["x"] > width * 0.70:
            continue
        text = row["text"]
        if row["score"] < 0.75 or is_cjk(text) or not re.search(r"[A-Za-z]", text):
            continue
        marker = compact_marker(text)
        if marker.startswith(("firstlisten", "newwords", "notesonthetext", "summarywriting")):
            continue
        cleaned = latin_text(text)
        if cleaned:
            body.append(cleaned)
    return latin_text(" ".join(body))


def find_article_start(rows: list[dict[str, Any]], title_y: int, width: float) -> int | None:
    """Find the first article line after the listening prompt and question.

    A question can also occur inside the article (usually in dialogue), so using
    the last question mark on the page incorrectly discards the rest of the
    lesson. The first substantial, non-question English line is a better page
    boundary for these textbook scans.
    """
    first_question_y = next(
        (
            row["y"]
            for row in rows
            if row["y"] > title_y + 120 and "?" in row["text"]
        ),
        None,
    )
    start_floor = max(title_y + 120, (first_question_y or title_y + 120) + 20)
    candidates = []
    for row in rows:
        if row["y"] <= start_floor or row["x"] > width * 0.70:
            continue
        text = latin_text(row["text"])
        if not text or is_cjk(text) or "?" in text:
            continue
        marker = compact_marker(text)
        if marker.startswith(("firstlisten", "listen", "answerthesequestions")):
            continue
        words = re.findall(r"[A-Za-z]+(?:'[A-Za-z]+)?", text)
        if len(words) >= 5 and len(text) >= 28:
            candidates.append(row["y"])
    return min(candidates) if candidates else None


def extract_chinese(page_blocks: list[dict[str, Any]]) -> str:
    for block in page_blocks:
        rows = block["rows"]
        ref_index = find_marker(rows, ("reference",))
        if ref_index is None:
            ref_index = next(
                (i for i, row in enumerate(rows) if "参考译文" in row["text"]),
                None,
            )
        if ref_index is None:
            continue
        end_index = find_marker(rows, ("summarywriting", "vocabulary", "composition"), ref_index)
        if end_index is None:
            end_index = len(rows)
        width = max((row["x"] for row in rows), default=1000)
        lines = []
        for row in rows[ref_index + 1 : end_index]:
            if row["x"] > width * 0.9 or not is_cjk(row["text"]):
                continue
            text = chinese_text(row["text"])
            if text and text not in lines and not re.fullmatch(r"[0-9]+", text):
                lines.append(text)
        if lines:
            return "".join(lines)
    return ""


def parse_lesson(lesson: int, start_page: int, blocks: list[dict[str, Any]]) -> dict[str, Any]:
    first_rows = blocks[0]["rows"] if blocks else []
    all_rows = [row for block in blocks for row in block["rows"]]
    title, title_cn, _ = find_title(first_rows, lesson)
    if not title or title == f"Lesson {lesson}":
        title, title_cn, _ = find_title(all_rows, lesson)
    if lesson in TITLE_OVERRIDES:
        title, title_cn = TITLE_OVERRIDES[lesson]
    original = extract_original(all_rows, lesson)
    chinese = extract_chinese(blocks)
    return {
        "lesson": lesson,
        "title": title,
        "title_cn": title_cn,
        "pdf_page": start_page,
        "chinese": chinese,
        "original": original,
    }


def requested_pages(book: int, mapping: dict[int, int], lesson_numbers: list[int]) -> dict[int, list[int]]:
    pages: dict[int, list[int]] = {}
    for lesson in lesson_numbers:
        start = mapping[lesson]
        # Book 3 puts the translation on the continuation page. The extra
        # page for Book 2 is requested only after the first parse if needed.
        pages[lesson] = [start, start + 1] if book == 3 else [start]
    return pages


def run_ocr(
    pdf_path: Path,
    pages: set[int],
    scale: float,
    workers: int,
    threads_per_worker: int,
    cache_dir: Path | None = None,
    max_side_len: int = 4000,
) -> dict[int, dict[str, Any]]:
    if not pages:
        return {}
    context = multiprocessing.get_context("spawn")
    result: dict[int, dict[str, Any]] = {}
    tasks = sorted(pages)
    pending = []
    cached = 0
    for page in tasks:
        if cache_dir:
            cache_path = cache_dir / f"page-{page:04d}.json"
            try:
                data = json.loads(cache_path.read_text(encoding="utf-8"))
                if data.get("page") == page and isinstance(data.get("rows"), list):
                    result[page] = data
                    cached += 1
                    continue
            except (OSError, ValueError, TypeError):
                pass
        pending.append(page)
    if cached:
        print(f"Loaded {cached}/{len(tasks)} pages from OCR cache", flush=True)
    if not pending:
        return result
    if cache_dir:
        cache_dir.mkdir(parents=True, exist_ok=True)
    with concurrent.futures.ProcessPoolExecutor(
        max_workers=workers,
        mp_context=context,
        initializer=init_worker,
        initargs=(str(pdf_path), scale, threads_per_worker, max_side_len),
    ) as pool:
        futures = {pool.submit(ocr_page, page): page for page in pending}
        for index, future in enumerate(concurrent.futures.as_completed(futures), start=1):
            page = futures[future]
            try:
                data = future.result()
                result[page] = data
                if cache_dir:
                    cache_path = cache_dir / f"page-{page:04d}.json"
                    temp_path = cache_path.with_suffix(".tmp")
                    temp_path.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
                    temp_path.replace(cache_path)
                print(f"OCR {index}/{len(pending)} page {page}", flush=True)
            except Exception as exc:
                print(f"OCR failed page {page}: {type(exc).__name__}: {exc}", file=sys.stderr, flush=True)
    return result


def main() -> None:
    parser = argparse.ArgumentParser(description="Build a scanned New Concept lesson corpus")
    parser.add_argument("--pdf", required=True, type=Path)
    parser.add_argument("--book", required=True, type=int, choices=(2, 3))
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--page-map", type=Path)
    parser.add_argument("--lesson-start", type=int, default=1)
    parser.add_argument("--lesson-end", type=int)
    parser.add_argument("--scale", type=float, default=2.0)
    parser.add_argument("--workers", type=int, default=4)
    parser.add_argument("--threads-per-worker", type=int, default=4)
    parser.add_argument("--max-side-len", type=int, default=4000)
    parser.add_argument("--cache-dir", type=Path)
    args = parser.parse_args()

    if not args.pdf.exists():
        raise SystemExit(f"PDF not found: {args.pdf}")
    lesson_count = 96 if args.book == 2 else 60
    end = args.lesson_end or lesson_count
    if not 1 <= args.lesson_start <= end <= lesson_count:
        raise SystemExit("Invalid lesson range")

    mapping = load_page_map(args.book, lesson_count, args.page_map)
    lesson_numbers = list(range(args.lesson_start, end + 1))
    pages_by_lesson = requested_pages(args.book, mapping, lesson_numbers)
    cache_dir = args.cache_dir or Path("tmp") / "ocr-cache" / f"book-{args.book}-scale-{args.scale:g}"
    page_blocks = run_ocr(
        args.pdf,
        {page for pages in pages_by_lesson.values() for page in pages},
        args.scale,
        max(1, args.workers),
        max(1, args.threads_per_worker),
        cache_dir,
        max(1000, args.max_side_len),
    )

    # If a Book 2 translation is not on the lesson page, OCR the next page.
    missing_translation = []
    parsed: dict[int, dict[str, Any]] = {}
    for lesson in lesson_numbers:
        start = mapping[lesson]
        blocks = [page_blocks[p] for p in pages_by_lesson[lesson] if p in page_blocks]
        item = parse_lesson(lesson, start, blocks)
        parsed[lesson] = item
        if args.book == 2 and not item["chinese"]:
            missing_translation.append(lesson)

    if missing_translation:
        extra_pages = {mapping[lesson] + 1 for lesson in missing_translation}
        extra = run_ocr(
            args.pdf,
            extra_pages,
            args.scale,
            max(1, args.workers),
            max(1, args.threads_per_worker),
            cache_dir,
            max(1000, args.max_side_len),
        )
        page_blocks.update(extra)
        for lesson in missing_translation:
            start = mapping[lesson]
            blocks = [page_blocks[p] for p in (start, start + 1) if p in page_blocks]
            parsed[lesson] = parse_lesson(lesson, start, blocks)

    lessons = [parsed[lesson] for lesson in lesson_numbers]
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(
        json.dumps(
            {
                "source": args.pdf.name,
                "book": args.book,
                "page_count": _pdf_page_count(args.pdf),
                "lessons_found": len(lessons),
                "lessons": lessons,
            },
            ensure_ascii=False,
            indent=2,
        ),
        encoding="utf-8",
    )
    complete = sum(bool(item["original"]) and bool(item["chinese"]) for item in lessons)
    print(f"Completed {args.pdf.name}: {complete}/{len(lessons)} lessons have both fields")


if __name__ == "__main__":
    main()
