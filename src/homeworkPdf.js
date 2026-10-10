import { PDFDocument, rgb } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import { zipSync, strToU8 } from 'fflate';
import { exportDate, reportBlocks, reportFilename, safeFilename, uniqueFilename } from './homeworkExport.js';

let fontPromise;
export function loadReportFont() {
  if (!fontPromise) {
    fontPromise = (async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 60000);
      try {
        const response = await fetch(import.meta.env.BASE_URL + 'fonts/ReportSans-Regular.ttf', { signal: controller.signal });
        if (!response.ok) throw new Error('字体下载失败，请重试');
        return new Uint8Array(await response.arrayBuffer());
      } catch {
        throw new Error('PDF 字体加载失败，请检查网络后重试');
      } finally { clearTimeout(timer); }
    })().catch((error) => { fontPromise = null; throw error; });
  }
  return fontPromise;
}

export async function createHomeworkPdf(report, className, homeworkTitle, fontBytes, blocks) {
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  const font = await doc.embedFont(fontBytes, { subset: true });
  const chars = new Set(font.getCharacterSet());
  const clean = (value) => [...String(value).normalize('NFC').replace(/\r\n?/g, '\n').replace(/\t/g, '    ')
    .replace(/\p{Cc}/gu, (ch) => ch === '\n' ? ch : '')]
    .map((ch) => ch === '\n' || chars.has(ch.codePointAt(0)) ? ch : `[U+${ch.codePointAt(0).toString(16).toUpperCase()}]`).join('');
  const W = 595.28, H = 841.89, M = 44, bottom = 48;
  const blue = rgb(0.09, 0.28, 0.5), ink = rgb(0.13, 0.16, 0.2), muted = rgb(0.4, 0.45, 0.5);
  let page, y;
  const newPage = () => {
    page = doc.addPage([W, H]); y = H - 70;
    page.drawText('回译本 · 作业批改', { x: M, y: H - 35, size: 9, font, color: muted });
    page.drawLine({ start: { x: M, y: H - 43 }, end: { x: W - M, y: H - 43 }, thickness: 0.6, color: rgb(0.8, 0.85, 0.9) });
  };
  const widths = new Map();
  const width = (s, size) => {
    const key = size + ':' + s;
    if (!widths.has(key)) widths.set(key, font.widthOfTextAtSize(s, size));
    return widths.get(key);
  };
  const wrap = (value, size) => {
    const lines = [];
    for (const paragraph of clean(value).split('\n')) {
      let line = '';
      for (const token of paragraph.match(/[A-Za-z0-9]+(?:['’.-][A-Za-z0-9]+)*|[^\S\n]+|[^\s]/gu) || []) {
        if (width(line + token, size) <= W - 2 * M) { line += token; continue; }
        if (line.trim()) { lines.push(line.trimEnd()); line = ''; }
        if (width(token, size) <= W - 2 * M) { line = token.trimStart(); continue; }
        for (const ch of token) {
          if (width(line + ch, size) > W - 2 * M && line) { lines.push(line); line = ''; }
          line += ch;
        }
      }
      lines.push(line.trimEnd());
    }
    return lines;
  };
  newPage();
  for (const block of blocks || reportBlocks(report, className, homeworkTitle)) {
    const heading = ['title', 'section', 'subheading'].includes(block.kind);
    const size = block.kind === 'title' ? 18 : block.kind === 'section' ? 13 : block.kind === 'subheading' ? 11 : 10.5;
    const leading = size * 1.65;
    const lines = wrap(block.text, size);
    if (heading && y - Math.min(lines.length * leading + 35, H - 120) < bottom) newPage();
    if (heading) y -= 8;
    for (const line of lines) {
      if (y - leading < bottom) newPage();
      if (line) page.drawText(line, { x: M, y, size, font, color: block.kind === 'warning' ? rgb(0.72, 0.16, 0.12) : heading ? blue : ink });
      y -= leading;
    }
    y -= heading ? 4 : 6;
  }
  const pages = doc.getPages();
  pages.forEach((p, index) => p.drawText(`${index + 1} / ${pages.length}`, { x: W - M - 50, y: 26, size: 9, font, color: muted }));
  doc.setTitle(report.name ? `${homeworkTitle} · ${report.name}` : homeworkTitle);
  doc.setAuthor('回译本');
  return doc.save();
}

/** Keep failures visible; never replace the latest missing submission with an older score. */
export async function buildHomeworkArchive(data, { fontBytes, onProgress = () => {}, cancelled = () => false } = {}) {
  if (!data.reports?.length) throw new Error('这次作业还没有学生提交');
  const bytes = fontBytes || await loadReportFont();
  const files = Object.create(null), used = new Set(), failures = [];
  let count = 0;
  for (const [index, report] of data.reports.entries()) {
    if (cancelled()) throw new Error('已取消导出');
    onProgress(index + 1, data.reports.length);
    if (report.error || !report.result) failures.push(`${report.name}（${report.studentNo}）：${report.error || '没有可用结果'}`);
    else {
      try {
        const pdf = await createHomeworkPdf(report, data.className, data.homework.title, bytes);
        files[uniqueFilename(reportFilename(report), used)] = pdf;
        count++;
      } catch { failures.push(`${report.name}（${report.studentNo}）：PDF 生成失败，请重新导出`); }
    }
    // Yield between students so progress, cancellation and the mobile UI remain responsive.
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  if (cancelled()) throw new Error('已取消导出');
  if (!count) throw new Error('没有可导出的批改结果。' + failures.join('；'));
  if (failures.length) files['导出失败名单.txt'] = strToU8(failures.join('\r\n'));
  return { bytes: zipSync(files, { level: 0 }), count, failures,
    filename: `${safeFilename(data.className)}_${safeFilename(data.homework.title)}_${exportDate()}.zip` };
}

export function downloadArchive(archive) {
  const url = URL.createObjectURL(new Blob([archive.bytes], { type: 'application/zip' }));
  const link = document.createElement('a');
  link.href = url; link.download = archive.filename;
  document.body.appendChild(link); link.click(); link.remove();
  // Mobile browsers may start reading the blob after the click handler returns.
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}
