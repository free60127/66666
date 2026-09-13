/**
 * 结果页（回译作业的成品页面）：标题 → 同课对比 → 中文/原稿/AI 修正/原文 → 逐句解析
 * → 词汇 / 习语 / 加分表达 → 总结。
 *
 * 这一整块原来长在 App.jsx 里（占全文约四分之一），但它是**纯展示**：
 * 只依赖 result / history / 收藏回调，不碰任何编辑态。拆出来之后 App 只剩"编排"。
 */import React from 'react';
import { formatDuration } from '../../format.js';
import { ArrowLeft, CheckCircle2, ChevronDown, ClipboardCopy, Download, Link2 } from 'lucide-react';
import { DraftText } from './bits.jsx';
import { ErrorProfile, Section, SentenceCard, VocabularyNotes, IdiomHighlights, SummaryBlock } from './cards.jsx';
import { PracticeCompare } from './Compare.jsx';

/** 平滑跳到结果页里的某个区块（.result 是滚动容器，scrollIntoView 会找最近的祖先） */
const jumpTo = (sel) => {
  if (typeof document === 'undefined') return;
  const el = document.querySelector(sel);
  if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
};

/** 顶部速览：评分 + 问题数 + 快捷跳转。手机端实测第一处错误在 1.5 屏之外，先给结论再给细节 */
function SheetGlance({ overall, sentences, hasVocab, hasIdiom, hasSummary }) {
  return (
    <div className="sheet-glance">
      <div className="glance-score"><strong>{overall.score ?? '-'}</strong><span>综合评分</span></div>
      <div className="glance-meta">
        <span>{sentences.length} 个句群</span>
        <span className="glance-dot">·</span>
        <span>{overall.issues ?? 0} 处问题</span>
      </div>
      <div className="glance-jump">
        <button type="button" onClick={() => jumpTo('.sheet-section.analysis')}>逐句解析</button>
        {hasVocab ? <button type="button" onClick={() => jumpTo('.sheet-section.vocab')}>词汇深度辨析</button> : null}
        {hasIdiom ? <button type="button" onClick={() => jumpTo('.sheet-section.idiom')}>地道习语</button> : null}
        {hasSummary ? <button type="button" onClick={() => jumpTo('.sheet-section.summary')}>学习总结</button> : null}
      </div>
    </div>
  );
}

/**
 * 四段对照材料（中文 / 原稿 / AI 修正版 / 原文）。
 * 默认展开状态**按屏幕宽度决定**：手机上默认折叠 —— 学生等 1-2 分钟拿到结果，
 * 第一眼该看到的是"错在哪"，而四段材料会把第一处错误推到 2 屏之外（实测数据）。
 * 桌面空间充裕，保持展开，不打扰原有阅读习惯；两端都能手动切换。
 */
function ReferenceBlocks({ result, allFindings }) {
  const [open, setOpen] = React.useState(() => (
    typeof window === 'undefined' || !window.matchMedia || !window.matchMedia('(max-width: 900px)').matches
  ));
  return (
    <div className={'refs' + (open ? ' refs-open' : '')}>
      <button type="button" className="refs-toggle" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <ChevronDown size={16} className={'refs-caret' + (open ? ' rot' : '')} />
        <span>对照材料</span>
        <span className="refs-hint">中文 / 原稿 / AI 修正版 / 原文{open ? '' : '（点击展开）'}</span>
      </button>
      {/*
        这里**始终渲染**、折叠只靠 CSS（.refs:not(.refs-open) .refs-body { display:none }）。
        原因：手机端默认折叠时若用条件渲染，用户直接「导出 PDF」会丢掉这四段材料 ——
        打印样式里再想显示就来不及了（DOM 里根本没有）。 */}
      <div className="refs-body">
        <Section label="中文" tone="cn"><p>{result.chinese}</p></Section>
        <Section label="原稿" tone="draft" note="红色标记 = 必须改正的错误（纯润色升级不再标线，可在下方逐句解析里对照学习）"><p><DraftText text={result.draft} findings={allFindings} /></p></Section>
        <Section label="AI 修正版" tone="ai"><p>{result.ai}</p></Section>
        <Section label="原文" tone="original"><p>{result.original || '（自由模式：未匹配到课文原文）'}</p></Section>
      </div>
    </div>
  );
}

function ResultSheetImpl({ result, onBack, onCopy, onShare, shareTip, fav, history, jobId }) {
  const overall = result.overall || {};
  // 分项得分在手机上默认折叠（约 300px，会把第一处错误再推下一屏）；桌面保持展开
  const [breakdownOpen, setBreakdownOpen] = React.useState(() => (
    typeof window === 'undefined' || !window.matchMedia || !window.matchMedia('(max-width: 900px)').matches
  ));
  const sentences = result.sentences || [];
  const allFindings = sentences.flatMap((s) => s.findings || []);
  return (
    <div className="result-sheet">
      <div className="result-toolbar">
        <button className="ghost-btn" onClick={onBack}><ArrowLeft size={15} />返回编辑</button>
        <button className="ghost-btn" onClick={onCopy}><ClipboardCopy size={15} />复制全部</button>
        <button className="ghost-btn" onClick={onShare}><Link2 size={15} />复制分享链接</button>
        <button className="ghost-btn" onClick={() => window.print()}><Download size={15} />导出 PDF</button>
        {shareTip ? <span className="share-tip" role="status" aria-live="polite">{shareTip}</span> : null}
      </div>
      <article className="sheet">
        <header className="sheet-title"><span className="eyebrow">BACK-TRANSLATE TRAINING · 回译训练作业</span><h1>{result.title}</h1>
          {result.aiLevel ? <span className="sheet-duration">润色等级 {result.aiLevel}</span> : null}
          {result.durationMs ? <span className="sheet-duration">本次练习用时 {formatDuration(result.durationMs)}</span> : null}
        </header>
        <SheetGlance
          overall={overall}
          sentences={sentences}
          hasVocab={(result.vocabularyNotes || []).length > 0}
          hasIdiom={(result.idiomHighlights || []).length > 0}
          hasSummary={(result.advancedSentences || []).length > 0 || (result.bonusExpressions || []).length > 0}
        />
        <PracticeCompare result={result} history={history} jobId={jobId} />
        <ReferenceBlocks result={result} allFindings={allFindings} />
        <section className="sheet-section analysis">
          <div className="section-heading"><span className="label-dot" /><h2>逐句解析与三版本对比</h2><span className="muted small">{sentences.length} 个句群 · {overall.issues ?? 0} 项分析</span></div>
          <div className="overall-card">
            <div className="score-ring"><strong>{overall.score ?? '-'}</strong><span>综合评分</span></div>
            <div className="overall-body">
              <p>{overall.summary || ''}</p>
              <div className="chips">{(overall.highlights || []).map((h, i) => <span key={'hl' + i} className="chip"><CheckCircle2 size={13} />{h}</span>)}</div>
              <div className="advice"><strong>练习建议</strong><ul>{(overall.advice || []).map((a, i) => <li key={'ad' + i}>{a}</li>)}</ul></div>
              {Array.isArray(overall.scoreBreakdown) && overall.scoreBreakdown.length ? (
                <div className={'score-breakdown' + (breakdownOpen ? '' : ' collapsed')}>
                  <button type="button" className="score-breakdown-title" aria-expanded={breakdownOpen} onClick={() => setBreakdownOpen((v) => !v)}>
                    分项得分
                    <ChevronDown size={14} className={'refs-caret' + (breakdownOpen ? ' rot' : '')} />
                  </button>
                  {/* 手机上默认折叠：这一块约 300px，会把第一处错误再往下推一屏。
                      桌面保持展开（空间够），打印时也强制展开（见 styles.css 的 @media print）。 */}
                  <div className="score-breakdown-body">
                  {overall.scoreBreakdown.map((b, i) => {
                    const max = Number(b.max) || 20;
                    const pct = Math.max(0, Math.min(100, (Number(b.score) || 0) / max * 100));
                    return (
                      <div key={'sb' + (b.label || '') + '#' + i}>
                        <div className="score-row">
                          <span className="score-label">{b.label}</span>
                          <div className="score-track"><div className="score-fill" style={{ width: pct + '%' }} /></div>
                          <span className="score-num">{b.score}/{max}</span>
                        </div>
                        {b.comment ? <div className="score-comment">{b.comment}</div> : null}
                      </div>
                    );
                  })}
                  </div>
                </div>
              ) : null}
            </div>
          </div>
          <ErrorProfile result={result} history={history} jobId={jobId} />
          {sentences.map((sentence, i) => <SentenceCard key={'s' + (sentence.cn || sentence.draft || '') + '#' + i} index={i} sentence={sentence} result={result} fav={fav} />)}
        </section>
        <VocabularyNotes items={result.vocabularyNotes} result={result} fav={fav} />
        <IdiomHighlights items={result.idiomHighlights} result={result} fav={fav} />
        <section className="sheet-section summary">
          <div className="section-heading"><span className="label-dot" /><h2>学习总结 · 可学习的高级句式与加分表达</h2></div>
          <SummaryBlock title="高级句式" tone="teal" items={result.advancedSentences} result={result} fav={fav} />
          <SummaryBlock title="加分表达" tone="gold" items={result.bonusExpressions} result={result} fav={fav} />
        </section>
      </article>
    </div>
  );
}
export const ResultSheet = React.memo(ResultSheetImpl);
