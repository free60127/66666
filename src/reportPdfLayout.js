import { rgb, pushGraphicsState, popGraphicsState, setTextRenderingMode, TextRenderingMode,
  setLineWidth, setStrokingRgbColor } from 'pdf-lib';
import { directionText } from './direction.js';
import { exportDate } from './homeworkExport.js';
import { formatDuration } from './format.js';
import { collectMarks, isMustFix } from './resultMarks.js';

const C = { ink: '#1c2733', muted: '#5f6b78', line: '#e6eaf0', blue: '#3b6fd4',
  teal: '#0f7a70', gold: '#9a6500', red: '#c0392b', green: '#2f9e44', purple: '#7a5ac9',
  draft: '#5a4a8a', reference: '#8a6d1a', white: '#ffffff', panel: '#fbfcfd', light: '#e8f0fb' };
const arr = (v) => Array.isArray(v) ? v.filter(Boolean) : [];
const fieldLabels = { word: '词语', pos: '词性', phonetic: '音标', meaning: '含义', register: '语域', tone: '语气',
  strength: '强度', usage: '用法', example: '例句', en: '英文', cn: '中文', parts: '构词', image: '记忆提示',
  family: '同根词', note: '说明', idiom: '表达', explanation: '解释', common: '普通说法', situation: '情境', type: '类型' };
const valueText = (v) => v == null ? '' : typeof v !== 'object' ? String(v)
  : Array.isArray(v) ? v.map(valueText).filter(Boolean).join(' / ')
    : Object.entries(v).map(([k, value]) => `${fieldLabels[k] || k}：${valueText(value)}`).join('\n');
const text = (value, options = {}) => ({ kind: 'text', runs: [{ text: valueText(value) }], ...options });
const rich = (runs, options = {}) => ({ kind: 'text', runs, ...options });
const box = (children, options = {}) => ({ kind: 'box', children: children.filter(Boolean), padding: 11, gap: 10,
  fill: C.panel, ...options });
const heading = (v) => text(v, { size: 13, bold: true, color: C.blue, before: 9, gap: 9, keep: 34 });
const label = (v) => text(v, { size: 9, bold: true, color: C.muted, before: 5, gap: 4, keep: 25 });

function markedRuns(value, findings) {
  const source = String(value || '');
  const marks = collectMarks(source, arr(findings).filter((f) => isMustFix(f) && f.operation !== 'insert'));
  const runs = []; let cursor = 0;
  for (const mark of marks) {
    if (mark.start > cursor) runs.push({ text: source.slice(cursor, mark.start) });
    runs.push({ text: source.slice(mark.start, mark.end), highlight: true }); cursor = mark.end;
  }
  if (cursor < source.length) runs.push({ text: source.slice(cursor) });
  return runs.length ? runs : [{ text: source }];
}

function synonyms(items) {
  if (!arr(items).length) return [];
  return [label('近义词对比'), ...arr(items).map((s) => typeof s !== 'object' ? box([text(s)], { fill: C.white, padding: 8, gap: 6 })
    : box([
      rich([{ text: s.word || '', bold: true }, { text: s.pos ? `  ${s.pos}` : '', color: C.purple },
        { text: s.phonetic ? `  ${s.phonetic}` : '', color: C.muted }], { size: 10, gap: 3 }),
      [s.register, s.tone, s.strength].filter(Boolean).length ? text([s.register, s.tone, s.strength].filter(Boolean).join('  ·  '), { size: 8.5, color: C.muted, gap: 3 }) : null,
      s.meaning ? text(s.meaning, { gap: 3 }) : null,
      s.usage ? text(s.usage, { gap: 3 }) : null,
      s.example ? text(s.example, { color: C.teal, gap: 2 }) : null,
    ], { fill: C.white, padding: 8, gap: 6, continuation: s.word || '近义词' }))];
}

function examples(items) {
  return arr(items).length ? [label('例句'), ...arr(items).map((ex) => typeof ex !== 'object' ? text(ex, { color: C.teal })
    : rich([{ text: ex.en || ex.example || '', color: C.teal },
      { text: ex.cn ? `  ${ex.cn}` : '', color: C.muted }]))] : [];
}

function extras(item) {
  return [arr(item.dimensions).length ? text('辨析维度  ' + arr(item.dimensions).map(valueText).join('  ·  '), { size: 9, color: C.blue }) : null,
    item.idiom ? text('表达提示  ' + valueText(item.idiom), { color: C.teal }) : null,
    ...synonyms(item.synonyms), ...examples(item.examples)].filter(Boolean);
}

const categoryColor = (cat) => /拼写|标点/.test(cat) ? C.red : /语法|时态|语态|句式/.test(cat) ? C.blue
  : /词义|词汇|搭配|近义|轻重|内涵|感情/.test(cat) ? C.gold : /语境|语域|语用|专名/.test(cat) ? C.purple : C.teal;

function findingCard(finding) {
  const level = finding.level || (isMustFix(finding) ? 'error' : 'study');
  const levelLabel = level === 'error' ? '必须改错' : level === 'improve' ? '可选提升' : '对照学习';
  const accent = level === 'error' ? C.red : level === 'improve' ? C.gold : C.teal;
  return box([
    rich([{ text: ` ${finding.category || '表达'} `, badge: categoryColor(finding.category || '') },
      { text: '  ' + levelLabel, color: C.muted }], { size: 8.5, gap: 7, keep: 30 }),
    finding.operation === 'insert' ? rich([{ text: `补充遗漏信息（附近译稿：“${finding.from || ''}”）：` },
      { text: finding.to || '', color: C.green, bold: true }])
      : rich([{ text: finding.from || '', color: C.red, strike: true }, { text: '  →  ', color: C.muted },
        { text: finding.to || '', color: C.green, bold: true }]),
    text(finding.explanation), ...extras(finding),
  ], { accent, continuation: `${finding.category || '表达'} · ${levelLabel}` });
}

/** Preserve the result's hierarchy; never flatten nested learning cards. */
export function reportPdfModel(report, className, homeworkTitle) {
  const result = report.result || {}, overall = result.overall || {}, dt = directionText(result.direction);
  const findings = arr(result.sentences).flatMap((s) => arr(s.findings));
  const model = [text(homeworkTitle || result.workTitle || result.title || '回译作业', { size: 19, bold: true, gap: 10, keep: 38 }),
    text(dt.eyebrow, { size: 8, color: C.muted }),
    text([className && `班级：${className}`, report.name && `姓名：${report.name}`, report.studentNo && `学号：${report.studentNo}`].filter(Boolean).join('    '), { color: C.muted }),
    text(`提交日期：${exportDate(report.at)}${report.late ? '（迟交）' : ''}${result.aiLevel ? '    润色等级：' + result.aiLevel : ''}${result.durationMs ? '    用时：' + formatDuration(result.durationMs) : ''}`, { size: 9, color: C.muted }),
    text('评分用于学习参考，不等同于考试成绩；必须改错与可选提升分别标注。', { size: 8.5, color: C.muted }),
  ];
  if (result.incomplete) model.push(text('提示：模型输出不完整，部分评分或解析可能缺失。', { color: C.red }));
  if (result.translationReview?.status === 'unavailable') model.push(text('本次语义复核未完成，请重点核对数字、条件和结论。', { color: C.gold }));
  if (arr(result.teacherComments).length) model.push(heading('教师评语'), box(arr(result.teacherComments).flatMap((entry) => [
    text([entry.className, entry.teacher || '教师'].filter(Boolean).join(' · '), { bold: true, color: C.teal }), text(entry.text),
  ]), { accent: C.teal, fill: '#f1faf5', continuation: '教师评语' }));
  model.push(heading('综合评价'), box([
    text(`综合评分  ${report.score ?? overall.score ?? '未评分'} / 100${overall.local ? '（' + (overall.score == null ? '评分暂不可用' : '本地估算') + '）' : ''}`, { size: 15, color: C.blue, bold: true }),
    text(overall.summary || '（未提供综合评价）'),
    ...(arr(overall.highlights).length ? [label('亮点'), ...arr(overall.highlights).map((v) => text('• ' + valueText(v), { color: C.teal }))] : []),
    ...(arr(overall.advice).length ? [label('练习建议'), ...arr(overall.advice).map((v) => text('• ' + valueText(v)))] : []),
    ...arr(overall.scoreBreakdown).flatMap((b) => [
      { kind: 'score', label: b.label || '', score: b.score, max: b.max || 20, gap: 5 },
      b.comment ? text(b.comment, { size: 8.5, color: C.muted, gap: 8 }) : null,
    ]),
  ], { accent: C.blue, continuation: '综合评价' }));
  model.push(heading('对照材料'));
  for (const [title, value, color] of [[dt.sectionSource, result.chinese, C.ink], [dt.sectionDraft, result.draft, C.draft],
    [dt.sectionAi, result.ai, C.teal], [dt.sectionReference, result.original || dt.emptyReference, C.reference]]) {
    model.push(box([text(title, { color: C.muted, bold: true, size: 9, keep: 22 }),
      rich(title === dt.sectionDraft ? markedRuns(value, findings) : [{ text: value || '（未提供）' }], { color })],
    { accent: color, fill: C.white, continuation: title }));
  }
  model.push(heading(dt.sentencesTitle));
  arr(result.sentences).forEach((sentence, i) => {
    const fs = arr(sentence.findings), number = String(i + 1).padStart(2, '0');
    model.push(box([
      rich([{ text: ` ${number} `, badge: C.blue }, { text: '  ' + (sentence.cn || ''), bold: true }], { size: 11, gap: 9, keep: 45 }),
      { kind: 'row', label: result.direction === 'en2cn' ? '我的译稿' : '原稿', runs: markedRuns(sentence.draft, fs), color: C.draft },
      { kind: 'row', label: result.direction === 'en2cn' ? 'AI 润色译文' : 'AI 修正版', runs: [{ text: sentence.ai || '（未提供）' }], color: C.teal },
      sentence.original ? { kind: 'row', label: result.direction === 'en2cn' ? '参考译文' : '课文原文', runs: [{ text: sentence.original }], color: C.reference } : null,
      ...fs.map(findingCard), fs.length ? null : text('该句未发现明显问题。', { size: 9, color: C.muted }),
    ], { fill: C.white, continuation: `句群 ${number}` }));
  });
  if (arr(result.vocabularyNotes).length) {
    model.push(heading('词汇深度辨析'));
    arr(result.vocabularyNotes).forEach((v) => model.push(box(typeof v !== 'object' ? [text(v)] : [
      rich([{ text: v.word || '', bold: true }, { text: v.phonetic ? '  ' + v.phonetic : '', color: C.muted },
        { text: v.type ? '  ' + v.type : '', color: C.blue }], { size: 12, keep: 25 }), text(v.meaning),
      v.morphology ? text(valueText(v.morphology), { size: 9, color: C.muted }) : null, ...extras(v), v.note ? text(v.note) : null,
    ], { accent: C.blue, continuation: typeof v === 'object' ? v.word : '词汇' })));
  }
  if (arr(result.idiomHighlights).length) {
    model.push(heading(result.direction === 'en2cn' ? '中文表达与译法' : '地道习语强化'));
    arr(result.idiomHighlights).forEach((v) => model.push(box(typeof v !== 'object' ? [text(v)] : [
      text(v.idiom, { size: 12, bold: true, color: C.teal, keep: 25 }),
      v.situation ? text(v.situation, { size: 9, color: C.muted }) : null,
      v.common ? text('普通说法：' + valueText(v.common), { color: C.muted }) : null,
      v.example ? text(v.example, { color: C.teal }) : null, text(v.explanation),
    ], { accent: C.teal, continuation: typeof v === 'object' ? v.idiom : '表达' })));
  }
  for (const [title, values, accent] of [['高级句式', result.advancedSentences, C.teal], ['加分表达', result.bonusExpressions, C.gold]]) {
    if (arr(values).length) model.push(heading(title), ...arr(values).map((v) => box([text(v)], { accent, continuation: title })));
  }
  return model;
}

/** Vector text/cards with measured pagination, shared by student and teacher exports. */
export function drawReportPdf(doc, font, model) {
  const W = 595.28, H = 841.89, M = 38, TOP = H - 62, BOTTOM = 52;
  const chars = new Set(font.getCharacterSet()), widths = new Map();
  const color = (hex) => rgb(...hex.slice(1).match(/../g).map((c) => parseInt(c, 16) / 255));
  const clean = (v) => [...String(v ?? '').normalize('NFC').replace(/\r\n?/g, '\n').replace(/\t/g, '    ')
    .replace(/\p{Cc}/gu, (ch) => ch === '\n' ? ch : '')]
    .map((ch) => ch === '\n' || chars.has(ch.codePointAt(0)) ? ch : `[U+${ch.codePointAt(0).toString(16).toUpperCase()}]`).join('');
  const width = (s, size) => {
    const key = size + ':' + s;
    if (!widths.has(key)) widths.set(key, font.widthOfTextAtSize(s, size));
    return widths.get(key);
  };
  const lines = (runs, size, available) => {
    const out = []; let line = [], used = 0;
    const flush = () => { while (line.length && !line.at(-1).text.trim()) line.pop(); out.push(line); line = []; used = 0; };
    const add = (token, run) => {
      if (!line.length && /^ +$/.test(token)) return;
      const w = width(token, size);
      if (used + w > available && line.length) flush();
      if (w > available) { for (const ch of token) add(ch, run); return; }
      if (!line.length && /^ +$/.test(token)) return;
      const previous = line.at(-1);
      if (previous && previous.style === run) previous.text += token;
      else line.push({ text: token, style: run });
      used += w;
    };
    for (const run of runs || []) {
      for (const token of clean(run.text).match(/\n|[A-Za-z0-9]+(?:['’.-][A-Za-z0-9]+)*| +|[^\s]/gu) || []) {
        if (token === '\n') flush(); else add(token, run);
      }
    }
    if (line.length) flush();
    return out;
  };
  const prepare = (node, available) => {
    const gap = node.gap ?? 6, before = node.before || 0;
    if (node.kind === 'box') {
      const children = node.children.filter(Boolean).map((n) => prepare(n, available - 2 * node.padding));
      return { ...node, children, height: children.reduce((n, c) => n + c.height, 0) + 2 * node.padding + gap, gap };
    }
    if (node.kind === 'score') return { ...node, height: 20 + gap, gap };
    const size = node.size || 10, leading = size * 1.6;
    const wrapped = lines(node.runs, size, available - (node.kind === 'row' ? 72 : 0));
    return { ...node, lines: wrapped, size, leading, gap, height: wrapped.length ? before + wrapped.length * leading + gap : 0 };
  };
  const nodes = model.filter(Boolean).map((node) => prepare(node, W - 2 * M));
  const pages = [], frames = []; let page, y;
  const command = (draw) => page.content.push(draw);
  const textAt = (s, x, baseline, size, tone = C.ink, bold = false) => command((p) => {
    const options = { x, y: baseline, size, font, color: color(tone) };
    if (bold) p.pushOperators(pushGraphicsState(), setTextRenderingMode(TextRenderingMode.FillAndOutline),
      setLineWidth(0.18), setStrokingRgbColor(options.color.red, options.color.green, options.color.blue));
    p.drawText(clean(s), options);
    if (bold) p.pushOperators(popGraphicsState());
  });
  const frameSegment = (frame) => page.backgrounds.push({ ...frame, height: Math.max(12, frame.top - y) });
  const newPage = () => {
    if (page) frames.forEach(frameSegment);
    page = { backgrounds: [], content: [] }; pages.push(page); y = TOP;
    for (const frame of frames) { frame.top = y; y -= frame.padding; }
    if (frames.length) {
      const frame = frames.at(-1);
      textAt((frame.continuation || '批改内容') + '（续）', frame.x + frame.padding, y - 9, 8, C.muted); y -= 17;
    }
  };
  const ensure = (height) => { if (y - height < BOTTOM) newPage(); };
  const openingHeight = (node) => {
    if (node.kind !== 'box' || node.height <= 210) return node.height;
    const [first, second] = node.children;
    const following = first?.keep && second ? (second.height <= 210 ? second.height : 45) : 0;
    return 2 * node.padding + Math.min(first?.height || 0, 100) + following + node.gap;
  };
  let drawNode;
  const drawChildren = (children, x, available) => {
    children.forEach((node, index) => {
      const next = children[index + 1];
      if ((node.keep || node.kind === 'score') && next) {
        ensure(node.height + openingHeight(next) + frames.reduce((n, f) => n + f.padding + f.gap, 0));
      }
      drawNode(node, x, available);
    });
  };
  drawNode = (node, x, available) => {
    if (!node.height) return;
    if (node.kind === 'box') {
      const capacity = TOP - BOTTOM - frames.reduce((n, f) => n + f.padding, 0) - (frames.length ? 17 : 0);
      if (node.height <= Math.min(capacity, 210)) ensure(node.height);
      else {
        // Reserve the first heading and its following row before opening a
        // frame, otherwise a page can end with an empty card border.
        ensure(openingHeight(node) + frames.reduce((n, f) => n + f.padding + f.gap, 0));
      }
      const frame = { ...node, x, width: available, top: y, depth: frames.length };
      frames.push(frame); y -= node.padding;
      drawChildren(node.children, x + node.padding, available - 2 * node.padding);
      ensure(node.padding); y -= node.padding; frameSegment(frame); frames.pop(); y -= node.gap;
      return;
    }
    if (node.kind === 'score') {
      ensure(node.height);
      const labelWidth = 85, barWidth = Math.max(20, available - labelWidth - 60), top = y;
      textAt(node.label, x, top - 11, 9, C.muted);
      command((p) => {
        p.drawRectangle({ x: x + labelWidth, y: top - 11, width: barWidth, height: 6, color: color(C.line) });
        const pct = Math.max(0, Math.min(1, Number(node.score) / Number(node.max)));
        if (Number.isFinite(pct) && pct > 0) p.drawRectangle({ x: x + labelWidth, y: top - 11, width: barWidth * pct, height: 6, color: color(C.blue) });
      });
      textAt(`${node.score ?? '—'}/${node.max}`, x + available - 48, top - 11, 9, C.blue);
      y -= node.height; return;
    }
    const reserves = frames.reduce((n, f) => n + f.padding + f.gap, 0) + node.gap;
    ensure((node.before || 0) + node.leading + (node.keep || 0) + reserves); y -= node.before || 0;
    node.lines.forEach((line, index) => {
      ensure(node.leading + reserves);
      const baseline = y - node.size, start = node.kind === 'row' ? x + 72 : x;
      if (node.kind === 'row' && index === 0) textAt(node.label, x, baseline, 8.5, C.muted, true);
      let cursor = start;
      for (const part of line) {
        const w = width(part.text, node.size), run = part.style;
        const position = cursor;
        if (run.highlight || run.badge) command((p) => {
          p.drawRectangle({ x: position - 1, y: baseline - 2, width: w + 2, height: node.size + 4, color: color(run.badge || '#ffe3e3') });
          if (run.highlight) p.drawLine({ start: { x: position, y: baseline - 2 }, end: { x: position + w, y: baseline - 2 }, thickness: 0.9, color: color(C.red) });
        });
        const tone = run.badge ? C.white : run.color || node.color || C.ink;
        textAt(part.text, cursor, baseline, node.size, tone, run.bold || node.bold);
        if (run.strike) command((p) => p.drawLine({ start: { x: position, y: baseline + node.size * 0.32 },
          end: { x: position + w, y: baseline + node.size * 0.32 }, thickness: 0.7, color: color(C.red) }));
        cursor += w;
      }
      y -= node.leading;
    });
    y -= node.gap;
  };
  newPage(); drawChildren(nodes, M, W - 2 * M);
  pages.forEach((plan, i) => {
    const p = doc.addPage([W, H]);
    plan.backgrounds.sort((a, b) => a.depth - b.depth).forEach((b) => {
      p.drawRectangle({ x: b.x, y: b.top - b.height, width: b.width, height: b.height,
        color: color(b.fill || C.white), borderColor: color(C.line), borderWidth: 0.7 });
      if (b.accent) p.drawRectangle({ x: b.x, y: b.top - b.height, width: 3, height: b.height, color: color(b.accent) });
    });
    plan.content.forEach((draw) => draw(p));
    p.drawText('回译本 · 作业批改', { x: M, y: H - 30, size: 8, font, color: color(C.muted) });
    p.drawLine({ start: { x: M, y: H - 41 }, end: { x: W - M, y: H - 41 }, thickness: 0.6, color: color(C.line) });
    p.drawText('huiyiben.cn', { x: M, y: 26, size: 8, font, color: color(C.muted) });
    p.drawText(`${i + 1} / ${pages.length}`, { x: W - M - 48, y: 26, size: 8, font, color: color(C.muted) });
  });
}

export function flatPdfModel(blocks) {
  return blocks.map((b) => ['title', 'section', 'subheading'].includes(b.kind)
    ? text(b.text, { size: b.kind === 'title' ? 19 : b.kind === 'section' ? 13 : 11, bold: true, color: C.blue, before: 8, keep: 30 })
    : text(b.text, { color: b.kind === 'warning' ? C.red : C.ink }));
}
