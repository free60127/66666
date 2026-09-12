/**
 * 结果页里反复出现的小组件：标红原稿、近义词行、音标、朗读按钮、收藏星标、知识点补充。
 * 都是叶子组件（不碰 App 状态），抽出来之后结果页那 800 行才有地方安放。
 */import React, { useEffect, useState } from 'react';
import { getPhonetic } from '../../api.js';
import { Star, Volume2 } from 'lucide-react';

export function collectMarks(text, findings) {
  const src = String(text || '');
  const arr = Array.isArray(findings) ? findings : [];
  if (!src || !arr.length) return [];
  const chars = [];
  const map = [];
  let prevWs = true;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (/\s/.test(ch)) {
      if (prevWs) continue;
      chars.push(' ');
      map.push({ s: i, e: i + 1 });
      prevWs = true;
    } else {
      chars.push(ch.toLowerCase());
      map.push({ s: i, e: i + 1 });
      prevWs = false;
    }
  }
  const norm = chars.join('');
  const taken = [];
  const marks = [];
  const needles = arr
    .map((f) => (f && typeof f.from === 'string' ? f.from.replace(/\s+/g, ' ').trim().toLowerCase() : ''))
    .filter((f) => f.length >= 2)
    .sort((a, b) => b.length - a.length);
  for (const needle of needles) {
    let idx = 0;
    while (idx <= norm.length - needle.length) {
      const pos = norm.indexOf(needle, idx);
      if (pos < 0) break;
      const start = map[pos].s;
      const end = map[pos + needle.length - 1].e;
      const overlap = taken.some(([a, b]) => start < b && end > a);
      if (!overlap) {
        marks.push({ start, end });
        taken.push([start, end]);
        break;
      }
      idx = pos + 1;
    }
  }
  return marks.sort((a, b) => a.start - b.start);
}

// 只有「必须改正的错误」才在原稿上标线；纯润色升级（improve/study）不标，避免学生误以为整句都错了
export const MUST_FIX_CATEGORY = /拼写|标点|语法|时态|语态|专名/;
export function isMustFix(finding) {
  const f = finding || {};
  if (typeof f.from !== 'string' || !f.from.trim()) return false;
  if (f.level === 'error') return true;
  // 模型偶尔漏填 level：拼写/标点/语法/时态这类硬错误仍按必须改错处理
  return !f.level && MUST_FIX_CATEGORY.test(String(f.category || ''));
}

export function DraftText({ text, findings }) {
  const src = String(text || '');
  const errs = (Array.isArray(findings) ? findings : []).filter(isMustFix);
  const marks = collectMarks(text, errs);
  if (!marks.length) return src;
  const out = [];
  let cursor = 0;
  marks.forEach((m, i) => {
    if (m.start > cursor) out.push(<span key={'t' + i}>{src.slice(cursor, m.start)}</span>);
    out.push(<mark key={'m' + i} className="hl" title="必须改正的错误">{src.slice(m.start, m.end)}</mark>);
    cursor = m.end;
  });
  if (cursor < src.length) out.push(<span key="tail">{src.slice(cursor)}</span>);
  return out;
}

export function SynRow({ s }) {
  if (!s) return null;
  if (typeof s === 'string') return <div className="syn-row"><div className="syn-head"><strong className="syn-word">{s}</strong></div></div>;
  return (
    <div className="syn-row">
      <div className="syn-head">
        <strong className="syn-word">{s.word}</strong>
        <Phonetic word={s.word} phonetic={s.phonetic} />
        <SpeakButton text={s.word} label={s.word} />
        {s.register ? <span className="syn-meta">{s.register}</span> : null}
        {s.tone ? <span className="syn-meta">{s.tone}</span> : null}
        {s.strength ? <span className="syn-meta">{s.strength}</span> : null}
      </div>
      {s.meaning ? <div className="syn-meaning">{s.meaning}</div> : null}
      {s.usage ? <div className="syn-usage">{s.usage}</div> : null}
      {s.example ? <div className="syn-ex">{s.example}</div> : null}
    </div>
  );
}

/* 音标：优先用模型返回的 phonetic；缺失时向后端查词典并缓存（内存 + localStorage） */
export const PHONETIC_KEY = 'bt-phonetics';
let phoneticMem = null;
export function phoneticCacheMap() {
  if (!phoneticMem) {
    try { phoneticMem = new Map(Object.entries(JSON.parse(localStorage.getItem(PHONETIC_KEY) || '{}'))); }
    catch { phoneticMem = new Map(); }
  }
  return phoneticMem;
}
export function persistPhonetic() {
  try { localStorage.setItem(PHONETIC_KEY, JSON.stringify(Object.fromEntries(phoneticCacheMap()))); } catch { /* ignore */ }
}
export function Phonetic({ word, phonetic }) {
  const given = String(phonetic || '').trim();
  const key = String(word || '').trim().toLowerCase();
  const [value, setValue] = useState(() => given || (key ? (phoneticCacheMap().get(key) || '') : ''));
  useEffect(() => {
    // given 有值时原来直接 return，导致 value 只在挂载时取一次：
    // 列表用下标 key 复用实例时，切换作业/筛选收藏会让音标停留在上一个词上（串词）。
    if (given) { setValue(given); return undefined; }
    if (!key) { setValue(''); return undefined; }
    const cache = phoneticCacheMap();
    if (cache.has(key)) { setValue(cache.get(key) || ''); return undefined; }
    setValue(''); // 换词先清空，避免旧音标短暂挂在新闻上
    let alive = true;
    getPhonetic(key).then((r) => {
      const v = String((r && r.phonetic) || '').trim();
      cache.set(key, v);
      persistPhonetic();
      if (alive) setValue(v);
    }).catch(() => { cache.set(key, ''); });
    return () => { alive = false; };
  }, [key, given]);
  if (!value) return null;
  return <span className="phonetic">{value.startsWith('/') ? value : '/' + value + '/'}</span>;
}

/**
 * 朗读按钮。
 *
 * 用浏览器内置的 Web Speech API —— **零依赖、零后端、零成本**，不需要任何 TTS 服务。
 * 学习工具没有发音是硬伤：词汇表已经有 IPA 了，配上读音才算完整。
 *
 * 几个坑：
 * · getVoices() 首次调用常常返回空数组（语音列表是异步加载的），所以监听 voiceschanged
 *   再缓存一次；拿不到就交给浏览器默认语音，不阻塞。
 * · 连续点多个词时旧语音会和新的叠在一起，所以每次先 cancel()。
 * · 浏览器不支持时直接不渲染按钮（而不是渲染一个点了没反应的）。
 */
let voiceCache = null;
export function pickEnglishVoice() {
  if (voiceCache) return voiceCache;
  try {
    if (!('speechSynthesis' in window)) return null;
    const all = window.speechSynthesis.getVoices() || [];
    if (!all.length) return null; // 还没加载好，下次再取
    voiceCache = all.find((v) => /^en[-_]US/i.test(v.lang)) || all.find((v) => /^en/i.test(v.lang)) || null;
    return voiceCache;
  } catch { return null; }
}
if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
  try { window.speechSynthesis.addEventListener('voiceschanged', () => { voiceCache = null; pickEnglishVoice(); }); } catch { /* 老浏览器 */ }
}

export function SpeakButton({ text, label, slow = false }) {
  const supported = typeof window !== 'undefined' && 'speechSynthesis' in window && typeof window.SpeechSynthesisUtterance === 'function';
  const [speaking, setSpeaking] = useState(false);
  const clean = String(text || '').trim();
  if (!supported || !clean) return null;
  const say = (e) => {
    e.stopPropagation();
    try {
      window.speechSynthesis.cancel(); // 连续点词时旧语音会叠上来
      const u = new SpeechSynthesisUtterance(clean);
      u.lang = 'en-US';
      u.rate = slow ? 0.72 : 0.95;
      const v = pickEnglishVoice();
      if (v) u.voice = v;
      u.onstart = () => setSpeaking(true);
      u.onend = () => setSpeaking(false);
      u.onerror = () => setSpeaking(false);
      window.speechSynthesis.speak(u);
    } catch { setSpeaking(false); }
  };
  return (
    <button
      type="button"
      className={'speak-btn' + (speaking ? ' speaking' : '')}
      onClick={say}
      title={label ? `朗读：${label}` : '朗读'}
      aria-label={label ? `朗读 ${label}` : '朗读'}
    >
      <Volume2 size={13} />
    </button>
  );
}

/** 从「英文例句 · 中文点拨：…」里取出英文部分 —— 朗读只需要英文。 */
export function englishPart(text) {
  return String(text || '').split(/\s*[·•]\s*中文/)[0].trim();
}

/* ---------- 收藏夹（本机 localStorage，无需数据库） ---------- */
export function FavStar({ active, onToggle }) {
  return (
    <button
      type="button"
      className={'fav-star' + (active ? ' on' : '')}
      onClick={(e) => { e.stopPropagation(); onToggle(); }}
      title={active ? '取消收藏' : '收藏这条知识点（可在右上角「收藏夹」快速复习）'}
      aria-label={active ? '取消收藏' : '收藏'}
    >
      <Star size={14} fill={active ? 'currentColor' : 'none'} />
    </button>
  );
}

export function FindingExtras({ finding }) {
  const f = finding || {};
  const dims = Array.isArray(f.dimensions) ? f.dimensions : [];
  const syns = Array.isArray(f.synonyms) ? f.synonyms : [];
  const exs = Array.isArray(f.examples) ? f.examples : [];
  if (!dims.length && !syns.length && !exs.length && !f.idiom) return null;
  return (
    <div className="finding-extras">
      {dims.length ? (
        <div className="dim-row"><span className="ext-label">辨析维度</span>
          <span className="dim-chips">{dims.map((d, i) => <span className="dim-chip" key={'fd' + i}>{d}</span>)}</span>
        </div>
      ) : null}
      {f.idiom ? <div className="idiom-note"><span className="ext-label">地道习语</span><strong>{f.idiom}</strong></div> : null}
      {syns.length ? (
        <div className="syn-block"><span className="ext-label">近义词对比</span>
          <div className="syn-list">{syns.map((s, i) => <SynRow key={'fs' + i} s={s} />)}</div>
        </div>
      ) : null}
      {exs.length ? (
        <div className="ex-block"><span className="ext-label">例句</span>
          {exs.map((x, i) => (
            <div className="example-line" key={'fe' + i}>
              <em>{x?.en || x?.example || ''}</em>
              {x?.cn ? <span>{x.cn}</span> : null}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

