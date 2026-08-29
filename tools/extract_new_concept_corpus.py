import json
import re
import sys
from pathlib import Path

import pymupdf
from rapidocr_onnxruntime import RapidOCR


def ocr_page(engine, page, scale=1.0, top_only=False):
    clip = page.rect
    if top_only:
        clip = pymupdf.Rect(0, 0, page.rect.width, page.rect.height * 0.22)
    pix = page.get_pixmap(matrix=pymupdf.Matrix(scale, scale), clip=clip, alpha=False)
    result, _ = engine(pix.tobytes('png'))
    if not result:
        return []
    rows = []
    for box, text, score in result:
        if score >= 0.35 and text.strip():
            y = min(point[1] for point in box)
            x = min(point[0] for point in box)
            rows.append((round(y), round(x), text.strip(), score))
    return sorted(rows)


def page_text(rows):
    return '\n'.join(text for _, _, text, _ in rows)


def main():
    if len(sys.argv) < 3:
        raise SystemExit('usage: extract_new_concept_corpus.py <pdf> <output-json>')
    pdf_path = Path(sys.argv[1])
    output_path = Path(sys.argv[2])
    output_path.parent.mkdir(parents=True, exist_ok=True)
    engine = RapidOCR()
    doc = pymupdf.open(pdf_path)
    lesson_pages = []
    for index, page in enumerate(doc):
        rows = ocr_page(engine, page, 0.48, top_only=True)
        header = page_text(rows[:35])
        matches = re.findall(r'Lesson\s*(\d{1,2})\b', header, re.I)
        if matches:
            lesson_no = int(matches[0])
            if not any(item['lesson'] == lesson_no for item in lesson_pages):
                print(f'found lesson {lesson_no} at page {index + 1}', flush=True)
                high_rows = ocr_page(engine, page, 1.55)
                lesson_pages.append({
                    'lesson': lesson_no,
                    'pdf_page': index + 1,
                    'raw': [{'y': y, 'x': x, 'text': text, 'score': round(score, 3)} for y, x, text, score in high_rows],
                })
    lesson_pages.sort(key=lambda item: item['lesson'])
    output_path.write_text(json.dumps({
        'source': pdf_path.name,
        'page_count': len(doc),
        'lessons_found': len(lesson_pages),
        'lessons': lesson_pages,
    }, ensure_ascii=False, indent=2), encoding='utf-8')
    print(f'completed {pdf_path.name}: {len(lesson_pages)} lessons', flush=True)


if __name__ == '__main__':
    main()
