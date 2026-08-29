# -*- coding: utf-8 -*-
"""
Extract per-lesson title/English original/Chinese translation from the scanned
NCE Book 2 PDF (image-only pages) using RapidOCR at 2.5x scale.

Usage:
  python tools/extract_book2_corpus.py <start_lesson> <end_lesson> <out_json>

The lesson -> pdf page mapping is taken from public/corpus/new-concept-2.json.
"""
import json, re, sys, os
import pymupdf
import pdfplumber  # noqa: F401 (keep available)
from rapidocr_onnxruntime import RapidOCR
from spellchecker import SpellChecker

PDF = r"E:/A新概念/新概念英语 第2册.pdf"
MAPPING = r"E:/AI/back translate/public/corpus/new-concept-2.json"
PDFPLUMBER = "pdfplumber"  # unused, kept for clarity

CJK = re.compile(r'[\u4e00-\u9fff]')
TERMINAL = ".!?'”\""


def has_cjk(s):
    return bool(CJK.search(s))


def clean_line(t):
    t = re.sub(r'^\d{1,2}(?=[A-Za-z])', '', t)   # stray line numbers like "5red"
    return t.strip()


def fix_english(text, spell):
    words = text.split()
    out = []
    i = 0
    while i < len(words):
        w = words[i]
        if i + 1 < len(words):
            nxt = words[i + 1]
            combo = w + nxt
            if combo in spell and (w not in spell or nxt not in spell):
                out.append(combo)
                i += 2
                continue
        out.append(w)
        i += 1
    text = " ".join(out)
    fixed = []
    for t in text.split():
        core = t.strip(",.!?;:'\"“”‘’")
        if (core.isalpha() and len(core) >= 3 and core[0].islower()
                and core not in spell and core not in {"utes"}):
            cand = spell.correction(core.lower())
            if cand and cand.lower() != core.lower() and len(cand) == len(core):
                # only accept same-length corrections (avoids over-correcting)
                if t.endswith(core):
                    fixed.append(t[: len(t) - len(core)] + cand)
                    continue
        fixed.append(t)
    return " ".join(fixed)


def ocr_rows(ocr, pix):
    pix_bytes = pix.tobytes("png")
    result, _ = ocr(pix_bytes)
    rows = []
    for box, text, score in result or []:
        if not text.strip():
            continue
        rows.append({
            "y": min(pt[1] for pt in box),
            "x": min(pt[0] for pt in box),
            "text": text.strip(),
        })
    rows.sort(key=lambda r: (r["y"], r["x"]))
    return rows


def merge_rows(a, b):
    # simple merge by y proximity (within 25px) keep first
    result = list(a)
    for r in b:
        if not any(abs(r["y"] - x["y"]) < 25 and r["text"].split()[:3] == x["text"].split()[:3] for x in result):
            result.append(r)
    result.sort(key=lambda r: (r["y"], r["x"]))
    return result


def extract_page(ocr, pdf, page_no, scale=2.5, spell=None):
    page = pdf[page_no - 1]
    pix = page.get_pixmap(matrix=pymupdf.Matrix(scale, scale), alpha=False)
    rows = ocr_rows(ocr, pix)
    width = pix.width

    # ---- title ----
    title_row = None
    for r in rows:
        m = re.search(r'Lesson\s*\d+', r["text"])
        if m:
            title_row = r
            title_match = m
            break
    if not title_row:
        return {"error": "no title"}
    lesson_num = int(title_match.group(0).split()[-1])
    title_en = title_row["text"][title_match.end():].strip()
    title_en = title_en.lstrip("'\"“”‘’ .").strip()
    title_cn = ""
    for r in rows:
        if abs(r["y"] - title_row["y"]) < 60 and r["x"] > width * 0.40 and has_cjk(r["text"]):
            title_cn = r["text"].strip()
            break

    # ---- markers ----
    marker_listen = None
    marker_newwords = None
    marker_ref = None
    marker_summary = None
    marker_notes = None
    for r in rows:
        norm = re.sub(r'[^A-Za-z]', '', r["text"]).lower()
        if marker_listen is None and "firstlisten" in norm:
            marker_listen = r
        if marker_newwords is None and norm.startswith("newwords"):
            marker_newwords = r
        if marker_notes is None and "notesonthetext" in norm:
            marker_notes = r
        if marker_ref is None and has_cjk(r["text"]) and "参考译文" in r["text"]:
            marker_ref = r
        if marker_summary is None and "summarywriting" in norm:
            marker_summary = r

    # ---- english story ----
    english = ""
    if marker_listen:
        # find instruction (immediate CJK row after listen)
        instruction = None
        for r in rows:
            if r["y"] > marker_listen["y"] - 5 and r["y"] < marker_listen["y"] + 110 and has_cjk(r["text"]) and r["x"] < width * 0.5:
                instruction = r
                break
        anchor_y = (instruction or marker_listen)["y"]
        end_row = marker_newwords or marker_notes
        end_y = end_row["y"] if end_row else page.rect.height * scale
        seg = [r for r in rows if anchor_y < r["y"] < end_y and r["x"] < width * 0.62]
        # drop instruction row itself
        seg = [r for r in seg if instruction is None or r is not instruction]
        # drop question rows: consecutive rows after instruction ending with '?'
        body = []
        for r in seg:
            t = clean_line(r["text"])
            if not t:
                continue
            body.append((r["y"], t))
        while body and body[0][1].rstrip().endswith("?") and len(body) > 1:
            body.pop(0)
        lines = [t for _, t in body]
        english = " ".join(lines).strip()
        if spell:
            english = fix_english(english, spell)
        if english and english[-1] not in TERMINAL and english.rstrip()[-1] not in TERMINAL:
            # try 3.0 scale and merge rows, redo extraction
            pix3 = page.get_pixmap(matrix=pymupdf.Matrix(3.0, 3.0), alpha=False)
            rows3 = ocr_rows(ocr, pix3)
            merged = merge_rows(rows, rows3)
            width3 = pix3.width
            seg = [r for r in merged if anchor_y < r["y"] < end_y and r["x"] < width3 * 0.62]
            seg = [r for r in seg if instruction is None or r is not instruction]
            body = []
            for r in seg:
                t = clean_line(r["text"])
                if t:
                    body.append((r["y"], t))
            while body and body[0][1].rstrip().endswith("?") and len(body) > 1:
                body.pop(0)
            english = " ".join(t for _, t in body).strip()
            if spell:
                english = fix_english(english, spell)

    # ---- chinese translation ----
    chinese = ""
    start_row = marker_ref
    if start_row is None and marker_notes is not None:
        # fallback: first CJK row after the last notes row
        last_notes_y = max((r["y"] for r in rows if has_cjk(r["text"]) and r["y"] >= marker_notes["y"] - 5 and r["y"] < (marker_summary["y"] if marker_summary else page.rect.height * scale)), default=marker_notes["y"])
        start_row = None
        for r in rows:
            if has_cjk(r["text"]) and r["y"] > last_notes_y + 20 and r["x"] < width * 0.62:
                if "课文译文" in r["text"] or "参考译文" in r["text"] or r["y"] - last_notes_y > 80:
                    start_row = r
                    break
    if start_row is not None:
        stop_y = marker_summary["y"] if marker_summary else page.rect.height * scale
        seg = [r for r in rows if start_row["y"] < r["y"] < stop_y and r["x"] < width * 0.62 and has_cjk(r["text"])]
        lines = []
        prev_y = None
        for r in seg:
            t = clean_line(r["text"])
            if not t or "参考译文" in t or "课文译文" in t:
                continue
            # skip the "摘要写作" chinese line if it slipped in
            if "摘要写作" in t or "Summary" in t:
                continue
            if prev_y is not None and r["y"] - prev_y > 90:
                lines.append("\n")
            lines.append(t)
            prev_y = r["y"]
        chinese = "".join(lines).replace("\n", "\n")
        chinese = re.sub(r'([\u4e00-\u9fff])·([\u4e00-\u9fff])', r'\1\2', chinese)
        chinese = chinese.replace("一·会儿", "一会儿")

    return {
        "lesson": lesson_num,
        "pdf_page": page_no,
        "title_en": title_en,
        "title_cn": title_cn,
        "english": english,
        "chinese": chinese,
    }


def main():
    start, end = int(sys.argv[1]), int(sys.argv[2])
    out_path = sys.argv[3]
    mapping = json.load(open(MAPPING, encoding="utf-8"))["lessons"]
    page_map = {x["lesson"]: x["pdf_page"] for x in mapping}
    pdf = pymupdf.open(PDF)
    ocr = RapidOCR()
    spell = SpellChecker()
    results = []
    for ln in range(start, end + 1):
        pn = page_map.get(ln)
        if not pn:
            print(f"skip lesson {ln}: no page", flush=True)
            continue
        item = extract_page(ocr, pdf, pn, scale=2.5, spell=spell)
        item["page"] = pn
        print(f"lesson {ln} page {pn} en={len(item['english'])} cn={len(item['chinese'])} title={item['title_en']!r}", flush=True)
        results.append(item)
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(results, f, ensure_ascii=False, indent=2)
    print("saved", out_path, len(results), flush=True)


if __name__ == "__main__":
    main()
