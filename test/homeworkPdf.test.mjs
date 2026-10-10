import assert from 'node:assert/strict';
import fs from 'node:fs';
import { unzipSync, strFromU8 } from 'fflate';
import { PDFDocument } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import { buildHomeworkArchive } from '../src/homeworkPdf.js';
const fontBytes = fs.readFileSync(new URL('../public/fonts/ReportSans-Regular.ttf', import.meta.url));
const font = fontkit.create(fontBytes);
for (const ch of '回译ɜʊːɪˌʌəɑɔʃʒθðŋ') assert.ok(font.hasGlyphForCodePoint(ch.codePointAt(0)), `PDF 字体必须覆盖 ${ch}`);
const report = { name: '同名学生', studentNo: '301', score: 0, at: Date.parse('2026-10-09T17:00:00Z'),
  result: { title: '中英文批改', direction: 'en2cn', chinese: 'English source.', draft: '中文初稿。', ai: '中文修正。', original: '中文参考。',
    teacherComments: [{ teacher: '教师', text: '完整教师评语' }], overall: { summary: '多页内容。'.repeat(1500) },
    sentences: [{ cn: 'English source.', draft: '中文初稿。', ai: '中文修正。', findings: [{ category: '词义', from: '词一', to: '词二', explanation: '解释。' }] }] } };
const data = { className: '测试班级', homework: { title: '某次作业' }, reports: [report, { ...report, studentNo: '302' },
  { name: '缺失学生', studentNo: '303', error: '批改结果已删除' }] };
const progress = [];
const archive = await buildHomeworkArchive(data, { fontBytes, onProgress: (n) => progress.push(n) });
assert.equal(archive.count, 2);
assert.equal(archive.failures.length, 1);
assert.deepEqual(progress, [1, 2, 3]);
const files = unzipSync(archive.bytes);
assert.deepEqual(Object.keys(files), ['同名学生_0_2026-10-10.pdf', '同名学生_0_2026-10-10_2.pdf', '导出失败名单.txt']);
assert.match(strFromU8(files['导出失败名单.txt']), /缺失学生.*批改结果已删除/);
for (const name of Object.keys(files).filter((n) => n.endsWith('.pdf'))) {
  const pdf = await PDFDocument.load(files[name]);
  assert.ok(pdf.getPageCount() > 2, '长作业应自动分页');
  assert.equal(pdf.getTitle(), '某次作业 · 同名学生');
}
await assert.rejects(buildHomeworkArchive({ ...data, reports: [] }, { fontBytes }), /还没有学生提交/);
await assert.rejects(buildHomeworkArchive({ ...data, reports: [data.reports[2]] }, { fontBytes }), /没有可导出/);
let cancelled = false;
await assert.rejects(buildHomeworkArchive(data, { fontBytes, cancelled: () => cancelled, onProgress: () => { cancelled = true; } }), /已取消导出/);
console.log('✅ PDF 批量打包：中文命名、零分、重复文件、多页、失败名单、全失败和取消测试通过');
