import json, sys, re
from pathlib import Path
import pymupdf
from rapidocr_onnxruntime import RapidOCR

def main():
    pdf, out, start, step, count = Path(sys.argv[1]), Path(sys.argv[2]), int(sys.argv[3]), int(sys.argv[4]), int(sys.argv[5])
    first_lesson = int(sys.argv[6]) if len(sys.argv) > 6 else 1
    d = pymupdf.open(pdf); ocr = RapidOCR(); rows = []
    for lesson in range(first_lesson, min(count + 1, first_lesson + int(sys.argv[7]) if len(sys.argv) > 7 else count)):
        page_no = start + (lesson - first_lesson) * step
        if page_no >= len(d): break
        page = d[page_no]
        height = page.rect.height
        clips = [pymupdf.Rect(0, 0, page.rect.width, height * 0.5), pymupdf.Rect(0, height * 0.48, page.rect.width, height * 0.94)]
        chunks = []
        for clip in clips:
            pix = page.get_pixmap(matrix=pymupdf.Matrix(1.0, 1.0), clip=clip, alpha=False)
            result, _ = ocr(pix.tobytes('png'))
            chunks.append('\n'.join(item[1].strip() for item in (result or []) if item[1].strip()))
        text = '\n'.join(chunks)
        title = next((x for x in text.splitlines() if re.search(r'Lesson\s*' + str(lesson), x, re.I)), f'Lesson {lesson}')
        rows.append({'lesson': lesson, 'pdf_page': page_no + 1, 'title_line': title, 'raw_text': text})
        print(f'{pdf.name}: lesson {lesson}/{count} page {page_no + 1}', flush=True)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps({'source': pdf.name, 'lessons': rows}, ensure_ascii=False, indent=2), encoding='utf-8')

if __name__ == '__main__': main()
