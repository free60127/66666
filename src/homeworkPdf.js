import { PDFDocument } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import { zipSync, strToU8 } from 'fflate';
import { drawReportPdf, flatPdfModel, reportPdfModel } from './reportPdfLayout.js';
import { exportDate, reportFilename, safeFilename, uniqueFilename } from './homeworkExport.js';

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
  drawReportPdf(doc, font, blocks ? flatPdfModel(blocks) : reportPdfModel(report, className, homeworkTitle));
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
