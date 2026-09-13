/**
 * 结果页的正文卡片：错误类型分布、逐句解析、词汇/习语/加分表达、分节外壳。
 */import React, { useMemo, useState } from 'react';
import { loadResultCache } from '../../storage.js';
import { tallyCategories } from '../../progress.js';
import { hasMorphology, favFromFinding, favFromVocab, favFromIdiom, favFromExpression } from '../../favorites.js';
import { LEVEL_LABEL } from '../../constants.js';
import { DraftText, FavStar, FindingExtras, Phonetic, SpeakButton, SynRow } from './bits.jsx';

// 知识点分类 → 结果页的颜色标记（与 styles.css 里的 .cat-* 对应）
const CATEGORY_COLOR = {
  拼写: 'red', 标点: 'red', 语法: 'blue', 时态: 'blue', 语态: 'blue', 句式: 'blue',
  词义: 'gold', 近义词辨析: 'gold', 搭配: 'gold', 语义轻重: 'gold', 内涵外延: 'gold',
  感情色彩: 'gold', 语境: 'purple', 语域: 'purple', 语用: 'purple',
  流畅度: 'teal', 地道程度: 'teal', 习语: 'teal', 专名: 'purple', 其他: 'gray',
};

/**
 * 错误类型聚合。
 *
 * 每次分析都会给每条 finding 打 category（语法 / 时态 / 搭配 / 冠词 / 语域 …），
 * 但从来不汇总 —— 学生看得到"这一句错在哪"，看不到"我一直在错什么"。
 * 而后者才是回译训练真正能改变行为的地方。
 *
 * level 分三档：error(必须改错) / improve(润色升级) / study(对照学习)。
 * 只把 error 计入"常犯错误"，improve 单独算"可提升点" —— 混在一起会让学生误以为
 * 自己满篇是错，实际很多只是"还能更好"。
 */
function ErrorProfileImpl({ result, history, jobId }) {
  const [scope, setScope] = useState('recent'); // recent = 跨历史 | this = 只算本次

  /**
   * 先算出"手上有哪几次结果"（**与当前选择无关**），再按 scope 取参与统计的那一份。
   *
   * 两个坑都在这里：
   *  1) 原来只有一份 `recent`，而 `multi = t.used > 1` 直接从它算 —— 点「只算本次」后
   *     used 变 1、multi 变 false，**整行切换按钮自己消失了**，用户再也切不回去（用户实测反馈）。
   *     所以「能不能跨次看」必须由**可用数据**决定，不能由"当前选择"决定。
   *  2) 去重原来用对象身份（`r === result`）—— 但结果页拿到的是 normalize 后的新对象，
   *     而缓存里是另一次 JSON.parse 出来的副本，**同一次作业会被算两次**：
   *     明明只练过一遍却显示"最近 2 次作业"，柱状图也被当前这次重复加权。
   *     所以按 jobId 去重（当前这次单独加，历史里跳过它）。
   */
  const recentAll = useMemo(() => {
    const out = [];
    for (const h of (Array.isArray(history) ? history : []).slice(0, 12)) {
      if (!h || !h.jobId) continue;
      if (jobId && h.jobId === jobId) continue; // 当前这次由下面单独加，避免重复计入
      const r = loadResultCache(h.jobId);
      if (r && Array.isArray(r.sentences) && r.sentences.length) out.push(r);
    }
    // 本次结果可能还没进历史（或历史被清了），确保一定算进去
    if (result && Array.isArray(result.sentences) && result.sentences.length) out.unshift(result);
    return out;
  }, [result, history, jobId]);

  const tallyAll = useMemo(() => tallyCategories(recentAll), [recentAll]);
  const tallyThis = useMemo(() => tallyCategories(result ? [result] : []), [result]);
  const t = scope === 'this' ? tallyThis : tallyAll;

  if (!t.list.length) return null;
  const top = t.list.slice(0, 6);
  const max = top[0].total || 1;
  const multi = tallyAll.used > 1; // 与 scope 无关：只要有多次可看，开关就一直在

  return (
    <section className="sheet-section errprofile">
      <div className="section-heading">
        <span className="label-dot" />
        <h2>错误类型分布</h2>
        <span className="muted small">
          {scope === 'this' ? '本次作业' : `最近 ${t.used} 次作业`} · {t.sentences} 句 · {t.errors} 处必改
          {t.improves ? ` · ${t.improves} 处可提升` : ''}
        </span>
      </div>
      {multi && (
        <div className="errscope">
          <button className={'chip-btn' + (scope === 'this' ? ' active' : '')} onClick={() => setScope('this')}>只算本次</button>
          <button className={'chip-btn' + (scope === 'recent' ? ' active' : '')} onClick={() => setScope('recent')}>看最近几次</button>
        </div>
      )}
      <div className="errbars">
        {top.map((x) => (
          <div className="errbar-row" key={'ec' + x.cat}>
            <span className="errbar-label">{x.cat}</span>
            <span className="errbar-track">
              <span className="errbar-fill error" style={{ width: (x.error / max) * 100 + '%' }} />
              <span className="errbar-fill improve" style={{ width: (x.improve / max) * 100 + '%' }} />
            </span>
            <span className="errbar-num">
              {x.error ? <b>{x.error}</b> : null}{x.error && x.improve ? ' + ' : ''}{x.improve ? <i>{x.improve}</i> : null}
            </span>
          </div>
        ))}
      </div>
      <p className="errprofile-tip">
        <b>{top[0].cat}</b> 是你{scope === 'this' ? '本次' : '最近'}最集中的问题类型
        （{top[0].total} 处）。<span className="errlegend"><i className="dot error" />必改 <i className="dot improve" />可提升</span>
      </p>
    </section>
  );
}

function SectionImpl({ label, tone, note, children }) {
  return <section className={'sheet-section v-' + tone}><div className="section-heading"><span className="label-dot" /><h2>{label}</h2>{note ? <span className="section-note">{note}</span> : null}</div>{children}</section>;
}

function SentenceCardImpl({ index, sentence, result, fav }) {
  const findings = sentence.findings || [];
  return (
    <div className="sentence-card">
      <div className="sentence-head"><span className="sentence-index">{String(index + 1).padStart(2, '0')}</span><p className="sentence-cn">{sentence.cn}</p><span className="finding-count">{findings.length} 项</span></div>
      <div className="versions">
        <VersionRow label="原稿" tone="draft" text={<DraftText text={sentence.draft} findings={findings} />} />
        <VersionRow label="AI 修正版" tone="ai" text={sentence.ai} />
        {sentence.original ? <VersionRow label="课文原文" tone="original" text={sentence.original} /> : null}
      </div>
      <div className="findings">
        {findings.map((finding, i) => {
          const favItem = fav ? favFromFinding(finding, result) : null;
          return (
            <div className={'finding level-' + (finding.level || 'error')} key={'f' + (finding.from || '') + '→' + (finding.to || '') + '#' + i}>
              <div className="finding-top">
                <span className={'cat cat-' + (CATEGORY_COLOR[finding.category] || 'gray')}>{finding.category}</span>
                <span className="level">{LEVEL_LABEL[finding.level] || finding.level}</span>
                {fav ? <FavStar active={fav.has(favItem.id)} onToggle={() => fav.toggle(favItem)} /> : null}
              </div>
              <div className="finding-diff"><span className="from">{finding.from}</span><span className="arrow">→</span><strong className="to">{finding.to}</strong></div>
              <p className="finding-exp">{finding.explanation}</p>
              <FindingExtras finding={finding} />
            </div>
          );
        })}
        {findings.length === 0 && <div className="muted small">该句未发现明显问题。</div>}
      </div>
    </div>
  );
}

function VersionRowImpl({ label, tone, text }) {
  return <div className={'v-row ' + tone}><span className="v-label">{label}</span><p>{text}</p></div>;
}

function VocabularyNotesImpl({ items, result, fav }) {
  const arr = Array.isArray(items) ? items.filter(Boolean) : [];
  if (!arr.length) return null;
  return (
    <section className="sheet-section vocab">
      <div className="section-heading"><span className="label-dot" /><h2>词汇深度辨析</h2><span className="muted small">{arr.length} 组核心词 · 六大维度拆解</span></div>
      {arr.map((v, i) => {
        const dims = Array.isArray(v.dimensions) ? v.dimensions : [];
        const syns = Array.isArray(v.synonyms) ? v.synonyms : [];
        const exs = Array.isArray(v.examples) ? v.examples : [];
        const favItem = fav ? favFromVocab(v, result) : null;
        return (
          <div className="vocab-card" key={'vn' + (v.word || '') + '#' + i}>
            <div className="vocab-head">
              <strong className="vocab-word">{v.word}</strong><Phonetic word={v.word} phonetic={v.phonetic} /><SpeakButton text={v.word} label={v.word} />{v.type ? <span className="vocab-type">{v.type}</span> : null}
              {fav ? <FavStar active={fav.has(favItem.id)} onToggle={() => fav.toggle(favItem)} /> : null}
            </div>
            {v.meaning ? <p className="vocab-meaning">{v.meaning}</p> : null}
            {hasMorphology(v.morphology) ? (
              <div className="vocab-morph">
                {typeof v.morphology === 'string'
                  ? <div className="morph-line">🧩 {v.morphology}</div>
                  : (
                    <>
                      {v.morphology.parts ? <div className="morph-line">🧩 {v.morphology.parts}</div> : null}
                      {v.morphology.image ? <div className="morph-line morph-image">💡 {v.morphology.image}</div> : null}
                      {v.morphology.family ? <div className="morph-line morph-family">同根：{v.morphology.family}</div> : null}
                    </>
                  )}
              </div>
            ) : null}
            {dims.length ? <div className="dim-chips">{dims.map((d, j) => <span className="dim-chip" key={'vd' + j}>{d}</span>)}</div> : null}
            {syns.length ? <div className="syn-block"><span className="ext-label">近义词对比</span><div className="syn-list">{syns.map((s, j) => <SynRow key={'vs' + j} s={s} />)}</div></div> : null}
            {exs.length ? <div className="ex-block"><span className="ext-label">例句</span>{exs.map((x, j) => <div className="example-line" key={'ve' + j}><em>{x?.en || x?.example || ''}</em>{x?.cn ? <span>{x.cn}</span> : null}</div>)}</div> : null}
            {v.note ? <p className="vocab-note">{v.note}</p> : null}
          </div>
        );
      })}
    </section>
  );
}

function IdiomHighlightsImpl({ items, result, fav }) {
  const arr = Array.isArray(items) ? items.filter(Boolean) : [];
  if (!arr.length) return null;
  return (
    <section className="sheet-section idiom">
      <div className="section-heading"><span className="label-dot" /><h2>地道习语强化</h2><span className="muted small">{arr.length} 条 · 写作与口语加分素材</span></div>
      {arr.map((id, i) => {
        const favItem = fav ? favFromIdiom(id, result) : null;
        return (
          <div className="idiom-card" key={'ih' + (id.idiom || '') + '#' + i}>
            <div className="idiom-head">
              <span className="idiom-badge">习语</span><strong>{id.idiom}</strong><SpeakButton text={id.idiom} label={id.idiom} />{id.situation ? <span className="idiom-situation">{id.situation}</span> : null}
              {fav ? <FavStar active={fav.has(favItem.id)} onToggle={() => fav.toggle(favItem)} /> : null}
            </div>
            {id.common ? <div className="idiom-common">普通说法：{id.common}</div> : null}
            {id.example ? <div className="idiom-example">{id.example}</div> : null}
            {id.explanation ? <p className="idiom-exp">{id.explanation}</p> : null}
          </div>
        );
      })}
    </section>
  );
}

function SummaryBlockImpl({ title, tone, items, result, fav }) {
  const arr = Array.isArray(items) ? items : [];
  if (!arr.length) return null;
  return (
    <div className="summary-block">
      <h3 className={'summary-title ' + tone}>{title}</h3>
      {arr.map((item, i) => {
        const s = typeof item === 'string' ? item : JSON.stringify(item);
        const parts = s.split(/[·•]\s*中文[点说]/i);
        const favItem = fav ? favFromExpression(item, result, title) : null;
        return (
          <div className={'summary-card ' + tone} key={'sm' + tone + '#' + (typeof item === 'string' ? item : i)}>
            <div className="summary-head">
              <p className="summary-quote">{parts[0].trim()}</p>
              <SpeakButton text={parts[0].trim()} label={parts[0].trim().slice(0, 30)} />
              {fav ? <FavStar active={fav.has(favItem.id)} onToggle={() => fav.toggle(favItem)} /> : null}
            </div>
            {parts[1] ? <p className="summary-tip">中文点拨：{parts[1].trim()}</p> : null}
          </div>
        );
      })}
    </div>
  );
}

/* ---------- 收藏知识点自测题 ---------- */
export const ErrorProfile = React.memo(ErrorProfileImpl);
export const Section = React.memo(SectionImpl);
export const SentenceCard = React.memo(SentenceCardImpl);
export const VersionRow = React.memo(VersionRowImpl);
export const VocabularyNotes = React.memo(VocabularyNotesImpl);
export const IdiomHighlights = React.memo(IdiomHighlightsImpl);
export const SummaryBlock = React.memo(SummaryBlockImpl);
