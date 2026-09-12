/**
 * 结果页（回译作业的成品页面）：标题 → 同课对比 → 中文/原稿/AI 修正/原文 → 逐句解析
 * → 词汇 / 习语 / 加分表达 → 总结。
 *
 * 这一整块原来长在 App.jsx 里（占全文约四分之一），但它是**纯展示**：
 * 只依赖 result / history / 收藏回调，不碰任何编辑态。拆出来之后 App 只剩"编排"。
 */import React from 'react';
import { ArrowLeft, CheckCircle2, ClipboardCopy, Download, Link2 } from 'lucide-react';
import { formatDuration } from '../../format.js';
import { DraftText } from './bits.jsx';
import { ErrorProfile, Section, SentenceCard, VocabularyNotes, IdiomHighlights, SummaryBlock } from './cards.jsx';
import { PracticeCompare } from './Compare.jsx';

export function ResultSheet({ result, onBack, onCopy, onShare, shareTip, fav, history, jobId }) {
  const overall = result.overall || {};
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
        <PracticeCompare result={result} history={history} jobId={jobId} />
        <Section label="中文" tone="cn"><p>{result.chinese}</p></Section>
        <Section label="原稿" tone="draft" note="红色标记 = 必须改正的错误（纯润色升级不再标线，可在下方逐句解析里对照学习）"><p><DraftText text={result.draft} findings={allFindings} /></p></Section>
        <Section label="AI 修正版" tone="ai"><p>{result.ai}</p></Section>
        <Section label="原文" tone="original"><p>{result.original || '（自由模式：未匹配到课文原文）'}</p></Section>
        <section className="sheet-section analysis">
          <div className="section-heading"><span className="label-dot" /><h2>逐句解析与三版本对比</h2><span className="muted small">{sentences.length} 个句群 · {overall.issues ?? 0} 项分析</span></div>
          <div className="overall-card">
            <div className="score-ring"><strong>{overall.score ?? '-'}</strong><span>综合评分</span></div>
            <div className="overall-body">
              <p>{overall.summary || ''}</p>
              <div className="chips">{(overall.highlights || []).map((h, i) => <span key={'hl' + i} className="chip"><CheckCircle2 size={13} />{h}</span>)}</div>
              <div className="advice"><strong>练习建议</strong><ul>{(overall.advice || []).map((a, i) => <li key={'ad' + i}>{a}</li>)}</ul></div>
              {Array.isArray(overall.scoreBreakdown) && overall.scoreBreakdown.length ? (
                <div className="score-breakdown">
                  <div className="score-breakdown-title">分项得分</div>
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
              ) : null}
            </div>
          </div>
          <ErrorProfile result={result} history={history} />
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

