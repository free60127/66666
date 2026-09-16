/**
 * PDF 文字层提取测试。
 *
 * 为什么值得测：这是自己写的解析器（没引 pdf.js），最容易出的问题是
 * **静默返回空串** —— 页面看着"上传成功"，实际素材是空的，出题质量直接崩。
 * 所以这里既测"正常 PDF 能抠出字"，也测"扫描件（没文字层）会被识别成没字"，
 * 后者决定要不要提示用户改用拍照识别。
 *
 * 跑法：node test/pdfText.test.mjs
 */
import { extractPdfText, textFromContentStream } from '../src/pdfText.js';

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
};

/* ---------- 内容流解析（不依赖 PDF 外壳） ---------- */
{
  const s1 = 'BT /F1 12 Tf 72 720 Td (Hello World) Tj ET';
  check('Tj：最简单的单行', textFromContentStream(s1) === 'Hello World', JSON.stringify(textFromContentStream(s1)));

  const s2 = 'BT 72 720 Td (Line one) Tj T* (Line two) Tj ET';
  const t2 = textFromContentStream(s2);
  check('T* 换行', t2.includes('Line one') && t2.includes('Line two') && t2.indexOf('\n') > 0, JSON.stringify(t2));

  const s3 = 'BT [(Hel) -20 (lo) -400 (World)] TJ ET';
  const t3 = textFromContentStream(s3);
  check('TJ：数组片段拼接 + 大字距当空格', t3.replace(/\s+/g, ' ').trim() === 'Hello World', JSON.stringify(t3));

  const s4 = 'BT (a\\(b\\)c) Tj (tab\\there) Tj (o\\143tal) Tj ET';
  const t4 = textFromContentStream(s4);
  check('转义：括号 / 制表符 / 八进制', t4.includes('a(b)c') && t4.includes('tab\there') && t4.includes('octal'), JSON.stringify(t4));

  const s5 = 'BT <48656C6C6F> Tj ET';
  check('十六进制字符串', textFromContentStream(s5) === 'Hello', JSON.stringify(textFromContentStream(s5)));

  check('空内容不抛错', textFromContentStream('') === '' && textFromContentStream(null) === '');
  check('没有文字操作符时返回空（而不是把二进制当文字）',
    textFromContentStream('\x00\x01\x02 binary junk \xff\xfe') === '', JSON.stringify(textFromContentStream('\x00\x01 binary junk')));
}

/* ---------- 真 PDF（自己拼一个最小合法结构，内容流不压缩） ---------- */
function minimalPdf(text) {
  const content = `BT /F1 12 Tf 72 720 Td (${text}) Tj ET`;
  const objs = [
    '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n',
    '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n',
    '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>\nendobj\n',
    `4 0 obj\n<< /Length ${content.length} >>\nstream\n${content}\nendstream\nendobj\n`,
    '5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n',
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = [];
  for (const o of objs) { offsets.push(pdf.length); pdf += o; }
  const xref = pdf.length;
  pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`
    + offsets.map((n) => String(n).padStart(10, '0') + ' 00000 n \n').join('');
  pdf += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(pdf).buffer;
}

{
  const buf = minimalPdf('The quick brown fox');
  const r = await extractPdfText(buf);
  check('能从一个真实 PDF 结构里抠出正文', r.text.includes('The quick brown fox'), JSON.stringify(r.text).slice(0, 60));
  check('报告找到的流数量（便于判断是不是扫描件）', r.streams >= 1, `streams=${r.streams}`);

  const pages = await extractPdfText(minimalPdf('Page one text'));
  check('多流场景返回合并文本', pages.text.includes('Page one text'));

  // 扫描件：只有图片对象、没有文字操作符
  const scan = new TextEncoder().encode(
    '%PDF-1.4\n1 0 obj\n<< /Type /Page >>\nstream\n\x00\x01\x02\x03IMAGEBYTES\xff\xfe\nendstream\nendobj\n%%EOF\n',
  ).buffer;
  const rs = await extractPdfText(scan);
  check('扫描件（无文字层）识别为"没字"——调用方据此提示改用拍照',
    rs.text.length === 0, `len=${rs.text.length}`);

  check('空文件不抛错', (await extractPdfText(new ArrayBuffer(0))).text === '');
}

console.log('\n' + '='.repeat(62));
const failed = results.filter((r) => !r.ok);
console.log(failed.length ? `❌ ${failed.length}/${results.length} 项失败` : `✅ 全部 ${results.length} 项通过`);
process.exit(failed.length ? 1 : 0);
