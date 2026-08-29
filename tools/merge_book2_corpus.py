# -*- coding: utf-8 -*-
"""合并子代理转写的 96 课双语语料 -> public/corpus/new-concept-2-full.json"""
import json, re
from pathlib import Path

SRC = Path(r"E:/AI/back translate/test/agent_out/book2")
OUT = Path(r"E:/AI/back translate/public/corpus/new-concept-2-full.json")
LEGACY_OUTS = [
    Path(r"E:/AI/back translate/corpus/new-concept-2.json"),
    Path(r"E:/AI/back translate/public/corpus/new-concept-2.json"),
]

def norm_ws(s):
    if not isinstance(s, str): return ''
    s = s.replace('\u00a0', ' ').replace('\u3000', ' ')
    s = re.sub(r'[ \t]+', ' ', s)
    return s.strip()

def main():
    lessons = []
    for f in sorted(SRC.glob('lesson_*.json')):
        d = json.loads(f.read_text(encoding='utf-8'))
        d['english'] = norm_ws(d.get('english', ''))
        d['chinese'] = norm_ws(d.get('chinese', ''))
        lessons.append(d)
    lessons.sort(key=lambda x: x.get('lesson', 0))
    complete = [l for l in lessons if l.get('english') and l.get('chinese')]
    print('total files:', len(lessons), 'complete:', len(complete))
    present = {l.get('lesson') for l in lessons}
    missing = [n for n in range(1, 97) if n not in present]
    missing.extend(l['lesson'] for l in lessons if not l.get('english') or not l.get('chinese'))
    if missing:
        print('WARNING missing lessons/fields:', sorted(set(missing)))
    OUT.parent.mkdir(parents=True, exist_ok=True)
    payload = {'book': 2, 'source': '新概念英语 第2册.pdf', 'lessons': lessons}
    OUT.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding='utf-8')
    legacy = {
        'book': 2,
        'source': payload['source'],
        'lessons': [
            {
                'lesson': l.get('lesson'),
                'title': l.get('title_en', f"Lesson {l.get('lesson', '')}"),
                'title_cn': l.get('title_cn', ''),
                'pdf_page': l.get('pdf_page'),
                'chinese': l.get('chinese', ''),
                'original': l.get('english', ''),
            }
            for l in lessons
        ],
    }
    for legacy_out in LEGACY_OUTS:
        legacy_out.parent.mkdir(parents=True, exist_ok=True)
        legacy_out.write_text(json.dumps(legacy, ensure_ascii=False, indent=2), encoding='utf-8')
    print('saved legacy resources:', ', '.join(str(p) for p in LEGACY_OUTS))
    print('saved', OUT)

if __name__ == '__main__':
    main()
