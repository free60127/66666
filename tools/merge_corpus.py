import json, re, sys
from pathlib import Path

def clean(lines):
    out=[]
    for line in lines:
        line=re.sub(r'\s+', ' ', line).strip()
        if line and line not in out: out.append(line)
    return out

def parse_entry(item):
    lines=clean(item['raw_text'].splitlines())
    title=item.get('title_line','')
    start=next((i for i,x in enumerate(lines) if re.search(r'Lesson\s*'+str(item['lesson'])+r'\b',x,re.I)),0)
    body=lines[start+1:]
    stop_words=('new words','notes on the text','key structures','exercises','summary writing','comprehension','vocabulary','multiple choice')
    english=[]
    for line in body:
        if any(word in line.lower() for word in stop_words): break
        if re.search(r'[A-Za-z]{3}',line): english.append(line)
    chinese_start=next((i for i,x in enumerate(body) if '参考译文' in x or '参考译文' in x.replace(' ','') or (re.search(r'[\u4e00-\u9fff]',x) and i>len(body)//3)),None)
    chinese=[]
    if chinese_start is not None:
        for line in body[chinese_start+1:]:
            if any(word in line.lower() for word in stop_words): break
            if re.search(r'[\u4e00-\u9fff]',line): chinese.append(line)
    return {'lesson':item['lesson'],'title':title,'pdf_page':item['pdf_page'],'chinese':' '.join(chinese),'original':' '.join(english),'source_text':' '.join(lines)}

def main():
    output=Path(sys.argv[1]); entries=[]
    for source in sys.argv[2:]: entries.extend(json.loads(Path(source).read_text(encoding='utf-8'))['lessons'])
    entries=sorted(entries,key=lambda x:x['lesson'])
    output.parent.mkdir(parents=True,exist_ok=True)
    output.write_text(json.dumps({'lessons': [parse_entry(x) for x in entries]},ensure_ascii=False,indent=2),encoding='utf-8')
    print(f'written {output} with {len(entries)} lessons')
if __name__=='__main__': main()
