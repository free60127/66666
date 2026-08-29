# -*- coding: utf-8 -*-
import json, re, os, difflib
from pathlib import Path
from docx import Document

SRC = Path(r"E:/AI/back translate/test/agent_out/book2")

def norm(s):
    s = s or ''
    s = s.replace('\u2018', "'").replace('\u2019', "'").replace('\u201c', '"').replace('\u201d', '"')
    s = re.sub(r'\s+', ' ', s).strip()
    return s

def docx_original(name):
    doc = Document(rf"E:/A新概念/新概念2/{name}.docx")
    paras = [p.text.strip() for p in doc.paragraphs if p.text.strip()]
    # 原文段落在 '原文' 或 '原版' 之后
    idx = None
    for i, t in enumerate(paras):
        if t in ('原文', '原版'):
            idx = i
    body = paras[idx+1:] if idx is not None else []
    # 取到下一个 '参考译文'/'Summary' 为止的英文行
    out = []
    for t in body:
        if t in ('参考译文', 'Summary writing') or '中文' in t and '原文' in t:
            break
        if re.search(r'[A-Za-z]{3}', t):
            out.append(t)
        if len(out) > 4:
            break
    return ' '.join(out)

for name in ['lesson18', 'lesson20', 'lesson22']:
    n = int(re.search(r'(\d+)', name).group(1))
    f = SRC / ('lesson_%02d.json' % n)
    if not f.exists():
        print(name, 'MISSING FILE'); continue
    d = json.loads(f.read_text(encoding='utf-8'))
    orig = docx_original(name)
    sim = difflib.SequenceMatcher(None, norm(d.get('english','')), norm(orig)).ratio()
    print(f"lesson {n}: en_len={len(d.get('english',''))} docx_orig_len={len(orig)} similarity={sim:.3f}")
    print('  agent_en_head:', norm(d.get('english',''))[:120])
    print('  docx_orig     :', norm(orig)[:120])
