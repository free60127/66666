import json, os, glob, sys

def merge(book, agent_dir, out_file, source):
    lessons = {}
    for f in sorted(glob.glob(os.path.join(agent_dir, "lesson_*.json"))):
        try:
            d = json.load(open(f, encoding="utf-8"))
        except Exception as e:
            print("skip", f, e); continue
        n = int(d.get("lesson"))
        if n in lessons:
            print("dup lesson", n, f); continue
        lessons[n] = {
            "lesson": n,
            "title_en": str(d.get("title_en") or d.get("title") or "").strip(),
            "title_cn": str(d.get("title_cn") or "").strip(),
            "pdf_page": d.get("pdf_page"),
            "english": str(d.get("english") or d.get("original") or "").strip(),
            "chinese": str(d.get("chinese") or "").strip(),
        }
    data = {"book": book, "source": source, "lessons": [lessons[k] for k in sorted(lessons)]}
    os.makedirs(os.path.dirname(out_file), exist_ok=True)
    json.dump(data, open(out_file, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    bad = [k for k, v in lessons.items() if not v["english"] or not v["chinese"]]
    print(out_file, "lessons:", len(lessons), "bad:", bad)
    return len(lessons)

if __name__ == "__main__":
    merge(1, "test/agent_out/book1", "public/corpus/new-concept-1-full.json", "新概念英语 第1册.pdf")
    merge(4, "test/agent_out/book4", "public/corpus/new-concept-4.json", "新概念英语 第4册.pdf")
