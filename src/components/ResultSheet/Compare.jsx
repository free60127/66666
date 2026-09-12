/**
 * 「同一课文 · 与上次对比」：把这一次和上一次同课练习的差距算出来摆到结果页顶部。
 */import React, { useMemo } from 'react';
import { formatTime, formatDuration } from '../../format.js';
import { loadResultCache } from '../../storage.js';
import { compareWithPrevious } from '../../progress.js';

export function fmtDelta(delta, unit = '') {
  if (!delta) return '持平';
  return (delta > 0 ? '+' : '') + delta + unit;
}

export function pcTone(delta, lowerIsBetter) {
  if (!delta) return 'flat';
  return (lowerIsBetter ? delta < 0 : delta > 0) ? 'good' : 'bad';
}

/**
 * 「同一课文 · 与上次对比」。
 *
 * 回译练习的价值在于**同一篇课文的第二次**：分数涨没涨、上次错的那几类这次还在不在。
 * 数据本来就有（历史 + 结果缓存），这里只负责把它算出来摆在结果页最上面。
 * 没有上一次同课记录时整块不渲染（不占位、不显示空壳）。
 */
function PracticeCompareImpl({ result, history, jobId }) {
  const cmp = useMemo(
    () => compareWithPrevious({ history, result, jobId, readResult: loadResultCache }),
    [history, result, jobId],
  );
  if (!cmp) return null;
  const when = cmp.prev.daysAgo === 0 ? '今天' : cmp.prev.daysAgo === 1 ? '昨天'
    : (cmp.prev.daysAgo != null ? cmp.prev.daysAgo + ' 天前' : formatTime(cmp.prev.time));
  const summary = cmp.tried === 0
    ? '上次没有可归类的问题类型，这次直接看逐句解析。'
    : cmp.fixed === cmp.tried
      ? `上次最集中的 ${cmp.tried} 类问题，这次一处都没再出现。`
      : cmp.fixed
        ? `上次最集中的 ${cmp.tried} 类问题里，${cmp.fixed} 类这次已经改掉${cmp.worse ? `，${cmp.worse} 类反而更多了` : ''}。`
        : '上次的问题类型这次还在，重点看下面的逐句解析。';
  return (
    <section className="sheet-section practice-compare">
      <div className="section-heading">
        <span className="label-dot" />
        <h2>同一课文 · 与上次对比</h2>
        <span className="muted small">上次练习：{when}{cmp.prev.title ? ' · ' + cmp.prev.title : ''}</span>
      </div>
      <div className="pc-grid">
        {cmp.score ? (
          <div className={'pc-card ' + pcTone(cmp.score.delta, false)}>
            <span className="pc-label">综合评分</span>
            <span className="pc-value">{cmp.score.now == null ? '-' : cmp.score.now}<i className="pc-delta">{fmtDelta(cmp.score.delta)}</i></span>
            <span className="pc-from">上次 {cmp.score.prev == null ? '-' : cmp.score.prev}</span>
          </div>
        ) : null}
        <div className={'pc-card ' + pcTone(cmp.errors.delta, true)}>
          <span className="pc-label">必改错误</span>
          <span className="pc-value">{cmp.errors.now}<i className="pc-delta">{fmtDelta(cmp.errors.delta, ' 处')}</i></span>
          <span className="pc-from">上次 {cmp.errors.prev} 处</span>
        </div>
        {cmp.improves.prev || cmp.improves.now ? (
          <div className={'pc-card ' + pcTone(cmp.improves.delta, true)}>
            <span className="pc-label">可提升</span>
            <span className="pc-value">{cmp.improves.now}<i className="pc-delta">{fmtDelta(cmp.improves.delta, ' 处')}</i></span>
            <span className="pc-from">上次 {cmp.improves.prev} 处</span>
          </div>
        ) : null}
        {cmp.duration ? (
          <div className={'pc-card ' + pcTone(cmp.duration.delta, true)}>
            <span className="pc-label">本次用时</span>
            <span className="pc-value">{formatDuration(cmp.duration.now)}<i className="pc-delta">{cmp.duration.delta === 0 ? '持平' : (cmp.duration.delta > 0 ? '慢了 ' : '快了 ') + formatDuration(Math.abs(cmp.duration.delta))}</i></span>
            <span className="pc-from">上次 {formatDuration(cmp.duration.prev)}</span>
          </div>
        ) : null}
      </div>
      {cmp.items.length ? (
        <div className="pc-cats">
          <div className="pc-cats-title">上次的常犯类型，这次改掉了吗</div>
          {cmp.items.map((it) => (
            <div className={'pc-cat ' + it.state} key={'pc' + it.cat}>
              <span className="pc-cat-name">{it.cat}</span>
              <span className="pc-cat-num">{it.prev} → {it.now}</span>
              <span className="pc-cat-state">
                {it.state === 'fixed' ? '已改掉' : it.state === 'down' ? `少了 ${-it.delta} 处` : it.state === 'up' ? `多了 ${it.delta} 处` : '持平'}
              </span>
            </div>
          ))}
        </div>
      ) : null}
      <p className="pc-tip">{summary}</p>
    </section>
  );
}
export const PracticeCompare = React.memo(PracticeCompareImpl);
