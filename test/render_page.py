# -*- coding: utf-8 -*-
import pdfplumber, sys
path = r"E:/A新概念/新概念英语 第2册.pdf"
pno = int(sys.argv[1]) - 1
scale = float(sys.argv[2]) if len(sys.argv) > 2 else 2.0
out = sys.argv[3]
with pdfplumber.open(path) as pdf:
    page = pdf.pages[pno]
    im = page.to_image(resolution=200*scale) if False else page.to_image(resolution=144)
    im.save(out)
print("saved", out)
