/**
 * 间隔重复复习面板（收藏夹里的一张一张过）。
 */import React from 'react';
import { formatTime } from '../../format.js';
import { sm2Review, nextDueAt, dueLabel, FAV_KIND_LABEL, FAV_GRADES } from '../../favorites.js';
import { CheckCircle2 } from 'lucide-react';

export function FavReviewPanel({ session, items, onReveal, onGrade, onSkip, onExit }) {
  const total = session.ids.length;
  const done = Math.min(session.index, total);
  const item = done < total ? items.find((x) => x && x.id === session.ids[done]) : null;
  if (done >= total) {
    const next = nextDueAt(items);
    return (
      <div className="fav-review">
        <div className="fav-review-done">
          <CheckCircle2 size={22} />
          <strong>今日复习完成</strong>
        </div>
        <p className="muted small">
          本次复习 {session.reviewed} 条 · 忘了 {session.tally.forgot} · 一般 {session.tally.normal} · 简单 {session.tally.easy}
        </p>
        <p className="muted small">{next ? '下一次到期：' + formatTime(next) + '（' + dueLabel({ due: next }) + '）' : '这些收藏都已排到以后，暂时没有到期项。'}</p>
        <div className="fav-review-actions">
          <button className="primary-btn" onClick={onExit}>回到收藏列表</button>
        </div>
      </div>
    );
  }
  if (!item) {
    return (
      <div className="fav-review">
        <p className="muted small">这条收藏已经不在了（可能刚被删除）。</p>
        <div className="fav-review-actions"><button className="ghost-btn" onClick={onSkip}>跳过</button></div>
      </div>
    );
  }
  const now = Date.now();
  const grades = ['forgot', 'normal', 'easy'].map((g) => ({ g, label: FAV_GRADES[g], days: sm2Review(item, g, now).interval }));
  return (
    <div className="fav-review">
      <div className="fav-review-progress">
        <span>{done + 1} / {total}</span>
        <span className="fav-review-bar"><i style={{ width: (done / total) * 100 + '%' }} /></span>
        <button className="ghost-btn sm" onClick={onExit}>退出复习</button>
      </div>
      <div className="fav-card">
        <div className="fav-item-head">
          <span className="fav-kind">{FAV_KIND_LABEL[item.kind] || item.kind}</span>
          {item.category ? <span className="fav-cat">{item.category}</span> : null}
          <span className="fav-date">{item.lastReviewed ? '上次复习 ' + formatTime(item.lastReviewed) + (item.lastGrade ? ' · ' + (FAV_GRADES[item.lastGrade] || '') : '') : '还没复习过'}</span>
        </div>
        <div className="fav-title">{item.title}</div>
        {session.revealed ? (
          <>
            {item.body ? <div className="fav-body">{item.body}</div> : null}
            {item.extra ? <div className="fav-extra">{item.extra}</div> : null}
            {item.source ? <div className="fav-source">来自：{item.source}</div> : null}
          </>
        ) : (
          <p className="muted small">先自己回想一遍，再翻面核对。</p>
        )}
      </div>
      {session.revealed ? (
        <div className="fav-review-grades">
          {grades.map((x) => (
            <button className={'grade-btn ' + x.g} key={x.g} onClick={() => onGrade(x.g)}>
              <strong>{x.label}</strong>
              <span>{x.days} 天后再见</span>
            </button>
          ))}
        </div>
      ) : (
        <div className="fav-review-actions">
          <button className="primary-btn" onClick={onReveal}>显示答案</button>
        </div>
      )}
    </div>
  );
}

