/**
 * 模型返回结果的形状清洗（服务端）。
 *
 * 单独成模块的原因：这里有一条**业务规则**必须能被测试 ——
 * 模型有时会凑数，产出「went → went」这种 from 与 to 逐字相同的"改写对"。
 * 对学习者来说这是纯噪音（"我本来就写的 went，你让我改成 went？"），必须在入库前丢掉。
 *
 * 只做两件事：把值规整成前端能安全渲染的形状 + 丢掉无意义条目。
 * **不**改内容、不做容错猜测（那属于 prompt 的职责）。
 */

const objectArray = (v) => (Array.isArray(v) ? v.filter((x) => x && typeof x === 'object' && !Array.isArray(x)) : []);
const stringArray = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []);

/**
 * 判断两个表达是否"实质相同"。
 *
 * 刻意**只**归一化空白：大小写、标点、冠词等差异都是真实可批改的点
 * （"hello" → "Hello" 是大小写错误，"went" → "went." 是标点问题），
 * 归一化掉它们会把有效条目误删。这里只针对"逐字重复"这一种噪音。
 */
export function sameExpression(a, b) {
  const norm = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  const x = norm(a);
  return x !== '' && x === norm(b);
}

/** from→to 没有实际差异（或缺一半）的条目 = 噪音 */
export function isNoopFinding(f) {
  if (!f || typeof f !== 'object') return true;
  const from = String(f.from == null ? '' : f.from).trim();
  const to = String(f.to == null ? '' : f.to).trim();
  if (!from || !to) return true;      // 缺一半的对照没有意义
  return sameExpression(from, to);    // went → went
}

/**
 * 清洗 findings：类型规整 + 丢掉噪音条目 + 句内去重。
 * @returns {{list: object[], dropped: number}} dropped = 被丢掉的无意义条目数（供日志观察模型质量）
 */
export function cleanFindings(rawFindings) {
  const seen = new Set();
  const list = [];
  let dropped = 0;
  for (const f of objectArray(rawFindings)) {
    if (isNoopFinding(f)) { dropped += 1; continue; }
    const key = JSON.stringify([f.category || '', String(f.from).trim(), String(f.to).trim(),
      f.level || '', f.sourceQuote || '', f.primaryDimension || '', f.severity || '']);
    if (seen.has(key)) { dropped += 1; continue; } // 模型偶尔把同一条列两遍
    seen.add(key);
    list.push({
      ...f,
      dimensions: stringArray(f.dimensions),
      synonyms: Array.isArray(f.synonyms) ? f.synonyms.filter((x) => x != null) : [],
    });
  }
  return { list, dropped };
}

/** 句子数组清洗（findings 逐句过滤；顺带汇总丢了多少条，便于观察模型是否在凑数） */
export function sanitizeSentences(value) {
  let dropped = 0;
  const list = objectArray(value).map((s) => {
    const { list: findings, dropped: d } = cleanFindings(s.findings);
    dropped += d;
    return { ...s, findings };
  });
  return { list, dropped };
}

/** 范文赏析条目上限：范文就几十句，超过只会是模型在复读凑数 */
const MODEL_BREAKDOWN_MAX = 12;

/**
 * 清洗 modelBreakdown（写作方向的"范文赏析"，按文章功能拆解范文）。
 * 只做形状收敛：必需的 fn/sentence 非字符串或为空就丢条目，note 缺省空串，
 * relatesTo 夹取到 0..sentenceCount（0 = 无对应）；同一（fn, sentence）重复出现只收第一条。
 * 不改内容、不校验 sentence 是否真的逐字来自 original —— 那是 prompt 纪律的职责。
 */
export function sanitizeModelBreakdown(value, sentenceCount = 0) {
  const seen = new Set();
  const list = [];
  let dropped = 0;
  for (const item of objectArray(value)) {
    const fn = String(item.fn ?? item.function ?? '').trim().slice(0, 60);
    const sentence = String(item.sentence ?? '').trim();
    if (!fn || !sentence) { dropped += 1; continue; }
    const key = fn + '\n' + sentence;
    if (seen.has(key)) { dropped += 1; continue; }
    seen.add(key);
    const rawRel = Math.floor(Number(item.relatesTo) || 0);
    const relatesTo = Math.max(0, Math.min(rawRel, Math.max(0, sentenceCount)));
    list.push({ fn, sentence, note: String(item.note ?? '').trim().slice(0, 500), relatesTo });
    if (list.length >= MODEL_BREAKDOWN_MAX) break;
  }
  return { list, dropped };
}

export function sanitizeOverall(value) {
  const o = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  return { ...o, scoreBreakdown: objectArray(o.scoreBreakdown) };
}
