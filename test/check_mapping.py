# -*- coding: utf-8 -*-
import json
data = json.load(open(r"E:/AI/back translate/public/corpus/new-concept-2.json", encoding="utf-8"))
ls = data["lessons"]
print("total", len(ls))
nums = [x["lesson"] for x in ls]
print("min", min(nums), "max", max(nums), "missing", [n for n in range(1,97) if n not in nums])
print("dup", [n for n in set(nums) if nums.count(n)>1])
print("pages sample", [(x["lesson"], x["pdf_page"]) for x in ls[:12]])
