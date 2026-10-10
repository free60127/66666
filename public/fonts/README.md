# PDF font

ReportSans-Regular.ttf combines Noto Sans SC and Noto Sans at regular weight,
including Chinese, English and IPA phonetic symbols used in grading reports.
Sources (downloaded 2026-10-10):
- https://github.com/google/fonts/tree/main/ofl/notosanssc — NotoSansSC[wght].ttf
- https://github.com/google/fonts/tree/main/ofl/notosans — NotoSans[wdth,wght].ttf

Built with fontTools 4.66.1: instantiateVariableFont(wght=400) for both inputs,
also wdth=100 for Noto Sans; remove vhea/vmtx/BASE/STAT tables (reports use
horizontal regular text); merge with fontTools.merge.Merger and rename name
IDs 1/4 to Report Sans and 6 to ReportSans-Regular. Glyphs are not removed.
Distributed under the accompanying SIL Open Font Licenses (OFL.txt and
NotoSans-OFL.txt). This is a modified font, not an official Noto release.

Loaded from this site's own origin only when a user exports PDFs. Each PDF
embeds a subset of the font, retaining searchable Chinese and English text.
