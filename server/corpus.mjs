/**
 * 语料 / 内置课文库 / 课文匹配。
 *
 * 从 server/index.mjs 拆出来的第一块：这一段有 118 行，但**和 HTTP、任务队列、
 * 限流毫无关系** —— 它只做"把 public/corpus/*.json 读进来 + 按标题/中文/课号猜是哪一课"。
 * 之前扎在 1600 行的 index.mjs 里，改语料格式要在一屏一屏地翻。
 *
 * 九个库的语料**一律不随仓库分发**（.gitignore 排除了 public/corpus/*.json）：
 * 教材全文与考试真题都受版权保护，使用者自备有权使用的材料，按 README 的格式
 * 放进 public/corpus/ 的同名文件即可自动加载。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

let corpora = null;
function normalizeLesson(raw, book, source) {
  const english = String(raw.english || raw.original || '').trim();
  return {
    book,
    lesson: Number(raw.lesson),
    title_en: String(raw.title_en || raw.title || '').trim(),
    title_cn: String(raw.title_cn || '').trim(),
    section: String(raw.section || '').trim(), // 小标题分组（如「回译课文」库的 六个级别段）
    pdf_page: raw.pdf_page ?? null,
    chinese: String(raw.chinese || '').trim(),
    english,
    original: english,
    source,
  };
}
/* ---------- 内置库 ----------
 * 1-4 是新概念册次；5-9 是考试向的库（四级 / 六级 / 英语（一）/ 英语（二）/ 专八）。
 * **九个库的语料一律不随仓库分发**（.gitignore 排除了 public/corpus/*.json）：
 * 教材全文与考试真题都受版权保护，使用者需自备有权使用的材料，按 README 的格式
 * 放进 public/corpus/ 的同名文件即可自动加载。
 * 库是空的时候前端会直接提示该放哪个文件（而不是显示成"正在加载…"）。
 *
 * label 会随 /api/status 的 books 下发给前端做侧栏标签 —— 语料有无都能显示出来。 */
export const BOOK_META = {
  // 新概念 1-4 册语料已于 2026-09 正式下架（版权原因）：库位 1-4 移除，
  // 用户手里的语料 JSON 可用侧栏「导入语料 JSON」转成自建课文库继续使用。
  5: { label: '四级', source: '四级语料', file: 'cet4.json' },
  6: { label: '六级', source: '六级语料', file: 'cet6.json' },
  7: { label: '英语（一）', source: '英语（一）语料', file: 'english-1.json' },
  8: { label: '英语（二）', source: '英语（二）语料', file: 'english-2.json' },
  9: { label: '专八', source: '专八语料', file: 'tem8.json' },
  10: { label: '回译课文', source: '回译课文语料', file: 'huiyi.json' },
};
export const BOOK_IDS = Object.keys(BOOK_META).map(Number);
export const isValidBook = (n) => BOOK_IDS.includes(Number(n));
/** 每个库推荐的润色等级（前端切库时可以据此给个默认值；用户仍可自己改） */
export const BOOK_LEVEL_HINT = { 5: '四六级', 6: '四六级', 7: '考研/专四', 8: '考研/专四', 9: '专八', 10: '四六级' };
export function loadBook(book) {
  const meta = BOOK_META[Number(book)];
  if (!meta) return { book: Number(book), label: '', source: '', lessons: [] };
  const source = meta.source;
  const full = path.join(ROOT, 'public', 'corpus', meta.file);
  if (fs.existsSync(full)) {
    try {
      const raw = JSON.parse(fs.readFileSync(full, 'utf8'));
      return { book, label: meta.label, source: raw.source || source, lessons: (raw.lessons || []).map((l) => normalizeLesson(l, book, raw.source || source)).sort((a, b) => a.lesson - b.lesson) };
    } catch (e) { console.error('corpus parse failed:', full, e); }
  }
  // 语料文件缺失时返回空列表（前端会退回「自由模式」）。
  // 原先还有一段 test/agent_out 的遗留回退目录，已随测试产物清理掉。
  return { book, label: meta.label, source, lessons: [] };
}
export function getCorpora() {
  if (!corpora) corpora = new Map(BOOK_IDS.map((b) => [b, loadBook(b)]));
  return corpora;
}
export function getCorpus(book = 2) {
  return getCorpora().get(Number(book)) || { book: Number(book), label: '', lessons: [], source: '' };
}
export function allLessons(book = null) {
  if (book) return getCorpus(book).lessons;
  return [...getCorpora().values()].flatMap((c) => c.lessons);
}
export function findLesson(book, lessonNo) {
  return getCorpus(book).lessons.find((l) => l.lesson === Number(lessonNo)) || null;
}

function compact(text) {
  return String(text || '').toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g, '');
}
function lessonNumber(text) {
  const m = String(text || '').match(/(?:lesson|第\s*)\s*(\d{1,3})/i) || String(text || '').match(/\b(\d{1,3})\b/);
  return m ? Number(m[1]) : null;
}
function titleBook(text) {
  const t = String(text || '');
  // 只识别明确的“第 N 册 / book N”标记，避免把 Lesson 18 的“1”误判成第 1 册
  const m = t.match(/(?:book|volume)\s*([1-4])|第\s*([1-4])\s*册/i);
  if (!m) return null;
  return Number(m[1] || m[2] || m[3] || m[4]);
}
export function matchLesson({ title, chinese, book }) {
  const requestedBook = isValidBook(book) ? Number(book) : titleBook(title);
  const candidates = allLessons(requestedBook || null);
  const titleKey = compact(title);
  const cnKey = compact(chinese);
  const number = lessonNumber(title);
  const scored = candidates.map((l) => {
    const titleEn = compact(l.title_en);
    const titleCn = compact(l.title_cn);
    const sourceCn = compact(l.chinese);
    let score = 0;
    let reason = '';
    if (requestedBook && l.book === requestedBook) score += 30;
    if (number != null && l.lesson === number) { score += 220; reason += '课号匹配;'; }
    if (titleKey && (titleKey === titleEn || titleKey === titleCn)) { score += 180; reason += '标题精确匹配;'; }
    if (titleKey && (titleKey.includes(titleEn) || titleEn.includes(titleKey))) { score += 100; reason += '标题包含;'; }
    if (cnKey && sourceCn === cnKey) { score += 400; reason += '中文全文精确匹配;'; }
    if (cnKey && sourceCn) {
      let prefix = 0;
      while (prefix < Math.min(cnKey.length, sourceCn.length) && cnKey[prefix] === sourceCn[prefix]) prefix += 1;
      const p = Math.min(70, prefix / Math.max(1, Math.min(cnKey.length, sourceCn.length)) * 70);
      score += p;
      if (p >= 40) reason += '中文开头相似;';
    }
    return { lesson: l, score, reason };
  }).sort((a, b) => b.score - a.score);
  const best = scored[0] || null;
  if (!best || best.score < 60) return { match: null, score: 0, confidence: 'none', reason: '' };
  const second = scored[1] || null;
  let confidence = best.score >= 320 ? 'high' : (best.score >= 150 ? 'medium' : 'low');
  // 若第一名与第二名差距太小，降低置信度，避免“误判”
  if (second && second.score > 0 && best.score - second.score < Math.max(40, best.score * 0.15)) confidence = 'low';
  return { match: best.lesson, score: best.score, confidence, reason: best.reason };
}
export function resolveLesson({ book, lessonId, title, chinese }) {
  const n = Number(lessonId);
  if (Number.isFinite(n) && n > 0) return findLesson(isValidBook(book) ? Number(book) : 2, n);
  return matchLesson({ title, chinese, book }).match;
}
