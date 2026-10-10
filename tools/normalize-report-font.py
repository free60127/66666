"""Normalize merged TTF glyph alignment before fontkit creates PDF subsets.

Run with fontTools 4.66.1 after rebuilding ReportSans-Regular.ttf.
Short TrueType loca offsets store byte offsets divided by two. fontkit does
not pad odd-length source glyphs when choosing that short representation.
"""
from pathlib import Path
import sys
from fontTools.ttLib import TTFont

path = Path(sys.argv[1] if len(sys.argv) > 1 else "public/fonts/ReportSans-Regular.ttf")
font = TTFont(path)
font["glyf"].padding = 2
font.save(path)
check = TTFont(path)
assert all(offset % 2 == 0 for offset in check["loca"].locations)
print("Report font: all glyph offsets are even; short PDF subsets are safe.")
