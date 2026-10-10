import assert from 'node:assert/strict';
import fs from 'node:fs';
import { unzipSync, strFromU8 } from 'fflate';
import { PDFDocument, PDFName, decodePDFRawStream } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import { buildHomeworkArchive, createHomeworkPdf } from '../src/homeworkPdf.js';
import { reportPdfModel } from '../src/reportPdfLayout.js';
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

// A short report uses short TrueType loca offsets. Its searchable text can
// look correct even when the embedded glyph outlines are corrupt/invisible.
const shortReport = { result: { direction: 'en2cn', chinese: 'A little bread.', draft: '一个小面包。', ai: '一点面包。',
  sentences: [{ cn: 'A little bread.', draft: '一个小面包。', ai: '一点面包。', findings: [
    { category: '数量', level: 'error', from: '一个小面包', to: '一点面包', explanation: '数量不是尺寸。',
      synonyms: [{ word: 'bread', meaning: '面包', phonetic: '/bred/' }, { word: 'loaf', meaning: '一条面包' }] },
    { category: '语域', level: 'improve', from: '面包', to: '粮食', explanation: '可选表达' },
    { category: '漏译', level: 'error', operation: 'insert', from: '面包', to: '新鲜的', explanation: '补充信息' },
  ] }] } };
const model = reportPdfModel(shortReport, '', '短作业');
const sentenceCard = model.find((n) => n.kind === 'box' && n.continuation === '句群 01');
const draftRuns = sentenceCard.children.find((n) => n.kind === 'row').runs;
assert.equal(draftRuns.filter((r) => r.highlight).length, 1, '只标真实错误，不标可选提升或插入锚点');
assert.equal(draftRuns.find((r) => r.highlight).text, '一个小面包');
const synonymCards = sentenceCard.children.find((n) => n.kind === 'box').children.filter((n) => n.kind === 'box');
assert.equal(synonymCards.length, 2, '每个近义词应有自己的卡片');
assert.ok(synonymCards[0].children[0].runs.some((r) => r.text.includes('/bred/')));
const shortPdf = await PDFDocument.load(await createHomeworkPdf(shortReport, '', '短作业', fontBytes));
for (const page of shortPdf.getPages()) {
  const resources = page.node.Resources().lookup(PDFName.of('Font'));
  const embedded = resources.lookup(resources.keys()[0]).lookup(PDFName.of('DescendantFonts')).lookup(0)
    .lookup(PDFName.of('FontDescriptor')).lookup(PDFName.of('FontFile2'));
  const subset = fontkit.create(decodePDFRawStream(embedded).decode());
  let visible = 0;
  for (let i = 1; i < subset.numGlyphs; i++) if (subset.getGlyph(i).path.commands.length) visible++;
  assert.ok(visible > subset.numGlyphs * 0.9, '短 PDF 的字形必须可渲染，不能只有可提取的文字层');
}
console.log('✅ PDF 批量打包：中文命名、零分、重复文件、多页、失败名单、全失败和取消测试通过');
console.log('✅ PDF 卡片层次、错误标记、音标和短文档字形渲染回归测试通过');
