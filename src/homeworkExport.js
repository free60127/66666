import { directionText } from './direction.js';
import { formatDuration } from './format.js';

export function exportDate(timestamp = Date.now()) {
  const date = new Date(timestamp);
  if (!Number.isFinite(date.getTime())) return '日期未知';
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}

export function safeFilename(value, fallback = '未命名') {
  const clean = String(value ?? '').normalize('NFC').replace(/[<>:"/\\|?*]/g, '_').replace(/\p{Cc}/gu, '_')
    .replace(/[. ]+$/g, '').trim();
  const name = [...clean].slice(0, 60).join('') || fallback;
  return /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name) ? '_' + name : name;
}

export function reportFilename(report) {
  const score = typeof report.score === 'number' && Number.isFinite(report.score) ? report.score : '未评分';
  return `${safeFilename(report.name, '未命名学生')}_${score}_${exportDate(report.at)}.pdf`;
}

export function uniqueFilename(name, used) {
  const dot = name.lastIndexOf('.');
  const base = dot < 0 ? name : name.slice(0, dot);
  const ext = dot < 0 ? '' : name.slice(dot);
  let candidate = name;
  let n = 2;
  while (used.has(candidate.toLowerCase())) candidate = `${base}_${n++}${ext}`;
  used.add(candidate.toLowerCase());
  return candidate;
}

const labels = { word: '单词', meaning: '含义', pos: '词性', phonetic: '音标', register: '语域', tone: '语气',
  strength: '强度', usage: '用法', example: '例句', en: '英文', cn: '中文', note: '说明', type: '类型',
  parts: '构词', image: '记忆提示', family: '同根词', situation: '情境', idiom: '习语', common: '普通表达', explanation: '解释' };
const text = (value) => value == null ? '' : typeof value === 'object'
  ? Array.isArray(value) ? value.map(text).filter(Boolean).join('；')
    : Object.entries(value).map(([key, val]) => `${labels[key] || key}：${text(val)}`).join('；')
  : String(value);
const list = (value) => Array.isArray(value) ? value.filter(Boolean) : [];

/** A complete, direction-aware report; no dependence on collapsed screen sections. */
export function reportBlocks(report, className, homeworkTitle) {
  const result = report.result || {};
  const dt = directionText(result.direction);
  const overall = result.overall || {};
  const blocks = [];
  const add = (value, kind = 'body') => { if (value != null && text(value).trim()) blocks.push({ text: text(value), kind }); };
  const section = (title, value) => { add(title, 'section'); add(value || '（未提供）'); };
  add(homeworkTitle || result.workTitle || result.title || '回译作业', 'title');
  if (className || report.name || report.studentNo) add([className && `班级：${className}`, report.name && `姓名：${report.name}`, report.studentNo && `学号：${report.studentNo}`].filter(Boolean).join('    '));
  add(`综合评分：${report.score ?? '未评分'}${overall.local && report.score != null ? '（本地估算）' : ''}    提交日期：${exportDate(report.at)}${report.late ? '（迟交）' : ''}`);
  if (result.aiLevel) add('润色等级：' + result.aiLevel);
  if (result.durationMs) add('练习用时：' + formatDuration(result.durationMs));
  if (result.incomplete) add('提示：模型输出不完整，部分评分或解析可能缺失。', 'warning');
  for (const comment of list(result.teacherComments)) {
    add('教师评语', 'section'); add(`${comment.teacher || '教师'}：${comment.text || ''}`);
  }
  section('综合评价', overall.summary);
  for (const b of list(overall.scoreBreakdown)) add(`${b.label}：${b.score ?? '—'}/${b.max || 20}${b.comment ? '；' + b.comment : ''}`);
  if (list(overall.highlights).length) section('亮点', list(overall.highlights).map((v) => '• ' + text(v)).join('\n'));
  if (list(overall.advice).length) section('练习建议', list(overall.advice).map((v) => '• ' + text(v)).join('\n'));
  section(dt.sectionSource, result.chinese);
  section(dt.sectionDraft, result.draft);
  section(dt.sectionAi, result.ai);
  section(dt.sectionReference, result.original);
  add(dt.sentencesTitle, 'section');
  for (const [index, sentence] of list(result.sentences).entries()) {
    add(`句群 ${index + 1}`, 'subheading');
    add(`${dt.sectionSource}：${sentence.cn || ''}`);
    add(`${dt.sectionDraft}：${sentence.draft || ''}`);
    add(`${dt.sectionAi}：${sentence.ai || ''}`);
    if (sentence.original) add(`${dt.sectionReference}：${sentence.original}`);
    for (const finding of list(sentence.findings)) {
      const label = finding.level === 'error' ? '必改' : finding.level === 'improve' ? '可提升' : '分析';
      const change = finding.operation === 'insert'
        ? `补充遗漏信息（附近译稿：“${finding.from || ''}”）：${finding.to || ''}`
        : `${finding.from || ''} → ${finding.to || ''}`;
      add(`[${label} · ${finding.category || '表达'}] ${change}`, finding.level === 'error' ? 'warning' : 'body');
      add(finding.explanation);
      if (list(finding.dimensions).length) add('辨析维度：' + text(finding.dimensions));
      if (finding.idiom) add('习语：' + text(finding.idiom));
      if (list(finding.synonyms).length) add('近义词对比：' + text(finding.synonyms));
      if (list(finding.examples).length) add('例句：' + text(finding.examples));
    }
  }
  for (const [title, items] of [['词汇深度辨析', result.vocabularyNotes], ['地道习语', result.idiomHighlights],
    ['可学习的高级句式', result.advancedSentences], ['加分表达', result.bonusExpressions]]) {
    if (!list(items).length) continue;
    add(title, 'section');
    list(items).forEach((item, index) => add(`${index + 1}. ${text(item)}`));
  }
  return blocks;
}
