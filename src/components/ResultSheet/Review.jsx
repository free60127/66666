/**
 * 间隔重复复习面板（收藏夹里的一张一张过）。
 *
 * 键盘：空格翻面、1/2/3 = 忘了/一般/简单（与姊妹项目「单词本」同一套手感）。
 * 为什么要有：一轮复习动辄几十张卡，每张都"移鼠标 → 点显示答案 → 移鼠标 → 点评分"，
 * 手来回离开键盘反而更慢；三个评分按钮位置固定，数字键是零学习成本的映射。
 */import React, { useEffect, useRef } from 'react';
import { formatDay, formatTime } from '../../format.js';
import { sm2Review, nextDueAt, dueLabel, FAV_KIND_LABEL, FAV_GRADES } from '../../favorites.js';
import { CheckCircle2 } from 'lucide-react';

/** 数字键 → 档位（顺序 = 界面上从左到右的三个按钮） */
const GRADE_BY_KEY = { '1': 'forgot', '2': 'normal', '3': 'easy' };
/** 小键盘的 1/2/3 在 NumLock 关掉时 e.key 是 End/↓/PgDn，只能靠 e.code 认出来 */
const DIGIT_CODE = /^(?:Digit|Numpad)([1-3])$/;

/** 这次按键对应哪一档评分；不是评分键就返回空串 */
function gradeOfKey(e) {
  if (GRADE_BY_KEY[e.key]) return GRADE_BY_KEY[e.key];
  const m = DIGIT_CODE.exec(e.code || '');
  return m ? GRADE_BY_KEY[m[1]] : '';
}

function FavReviewPanelImpl({ session, items, onReveal, onGrade, onSkip, onExit }) {
  const total = session.ids.length;
  const done = Math.min(session.index, total);
  const item = done < total ? items.find((x) => x && x.id === session.ids[done]) : null;

  /**
   * 快捷键从 ref 里读回调，而不是走闭包：父组件传的 onReveal / onGrade 都是内联箭头，
   * 每次渲染身份都变，挂进依赖数组就等于每次重渲染都解绑/重绑一遍
   * （同一个坑见 useModals.js 的注释）。ref 在渲染期刷新，所以监听只在挂载时绑一次。
   */
  const latest = useRef({});
  latest.current = { onReveal, onGrade, live: Boolean(item), revealed: Boolean(session.revealed) };
  useEffect(() => {
    const onKeyDown = (e) => {
      // 输入法正在组合时不抢键：中文候选词的数字选词会被误当成评分
      if (e.isComposing || e.keyCode === 229) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;   // Ctrl+C / Cmd+1 之类照旧给浏览器
      const el = e.target;
      if (el && (el.isContentEditable || /^(?:INPUT|TEXTAREA|SELECT)$/.test(el.tagName || ''))) return;
      const cur = latest.current;
      if (!cur.live) return;   // 已完成、或这张卡刚被删掉

      if (e.key === ' ' || e.key === 'Spacebar' || e.code === 'Space') {
        // 必须拦掉默认行为：空格既会滚动页面，也会"点"当前聚焦的那个按钮 ——
        // 焦点常常正好停在评分按钮上，不拦就等于按空格顺手点了「忘了」。
        e.preventDefault();
        if (!cur.revealed) cur.onReveal();
        return;
      }
      const grade = gradeOfKey(e);
      if (!grade || !cur.revealed) return;
      e.preventDefault();
      cur.onGrade(grade);
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, []);

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
        {/* 只说"哪一天"、不说几点：排期按**自然日**翻篇（到期日 ≤ 今天就算到期），
            显示成"9/16 21:00"会让人以为要等到晚上九点，其实次日 00:00 就在队列里了。 */}
        <p className="muted small">{next ? '下一次复习：' + dueLabel({ due: next }) + '（' + formatDay(next) + ' 00:00 起）' : '这些收藏都已排到以后，暂时没有到期项。'}</p>
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
  const grades = ['forgot', 'normal', 'easy'].map((g, i) => ({ g, label: FAV_GRADES[g], days: sm2Review(item, g, now).interval, hotkey: i + 1 }));
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
            <button className={'grade-btn ' + x.g} key={x.g} onClick={() => onGrade(x.g)} title={'快捷键：' + x.hotkey}>
              <strong><kbd>{x.hotkey}</kbd>{x.label}</strong>
              <span>{x.days} 天后再见</span>
            </button>
          ))}
        </div>
      ) : (
        <div className="fav-review-actions">
          <button className="primary-btn" onClick={onReveal} title="快捷键：空格">显示答案<kbd>空格</kbd></button>
        </div>
      )}
    </div>
  );
}
export const FavReviewPanel = React.memo(FavReviewPanelImpl);
