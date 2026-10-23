/**
 * 练习计时器：累计用时 + 暂停/继续 + 刷新恢复 + 切课文自动归零。
 *
 * 为什么抽成 hook：
 *   1) 原实现把 timer 状态、归零 effect、toggle/reset 散在 App 的三处，
 *      "当前时刻"还要靠 App 每秒重渲染一次才能刷新（后来改成叶子组件才修掉）；
 *   2) 这段逻辑**可以独立测**（localStorage 恢复、暂停累计、切课归零），
 *      留在 3000 行的 App 里就只能靠手点。
 *
 * 注意：不要为了"显示当前用时"而把每秒的 tick 放进 App 状态 ——
 * 那会让整个 App 每秒重渲染一次；显示交给 <ElapsedDisplay>，它自己 tick。
 */
import { useEffect, useState } from 'react'

const TIMER_KEY = 'bt-timer';
const EMPTY = { running: false, startedAt: null, accumulated: 0, lessonKey: '' };

/** 页面不可见（切后台/关标签页）的时间不算练习时间：隐藏时记下 lastSeenAt，
 * 恢复时把 startedAt 平移过这段空窗——否则「写 5 分钟 → 挂机 2 小时 → 重开」会记 2 小时。 */
export function loadTimer() {
  try {
    const t = JSON.parse(localStorage.getItem(TIMER_KEY) || 'null');
    if (t && typeof t === 'object') {
      let startedAt = Number(t.startedAt) || null;
      if (t.running && startedAt && Number(t.lastSeenAt)) {
        startedAt += Math.max(0, Date.now() - Number(t.lastSeenAt));
      }
      return {
        running: Boolean(t.running),
        startedAt,
        accumulated: Math.max(0, Number(t.accumulated) || 0),
        lessonKey: String(t.lessonKey || ''),
      };
    }
  } catch { /* ignore */ }
  return { running: false, startedAt: null, accumulated: 0, lessonKey: '' };
}
export function saveTimer(t) {
  try { localStorage.setItem(TIMER_KEY, JSON.stringify(t)); } catch { /* ignore */ }
}

/**
 * @param {string} lessonKey 当前课文标识（切课自动归零）
 */
export function useTimer(lessonKey) {
  const [timer, setTimer] = useState(loadTimer);

  // 页面隐藏时快照「最后可见时刻」；从后台切回来把隐藏时长从计时里剔除
  useEffect(() => {
    const onVisibility = () => {
      if (document.hidden) {
        setTimer((t) => { if (t.running) saveTimer({ ...t, lastSeenAt: Date.now() }); return t; });
      } else {
        setTimer((t) => {
          if (!t.running || !t.startedAt) return t;
          let raw = null;
          try { raw = JSON.parse(localStorage.getItem(TIMER_KEY) || 'null'); } catch { /* ignore */ }
          const gap = raw?.lastSeenAt ? Math.max(0, Date.now() - Number(raw.lastSeenAt)) : 0;
          const next = { ...t, startedAt: t.startedAt + gap };
          saveTimer(next);
          return next;
        });
      }
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, []);

  // 切换课文 / 模式时自动归零重新计时；同一个 key（刷新页面）则原样保留
  useEffect(() => {
    setTimer((t) => {
      if (t.lessonKey === lessonKey) return t;
      const next = { ...EMPTY, lessonKey };
      saveTimer(next);
      return next;
    });
  }, [lessonKey]);

  const toggle = () => {
    setTimer((t) => {
      const now = Date.now();
      const next = t.running
        ? { ...t, running: false, accumulated: t.accumulated + Math.max(0, now - (t.startedAt || now)), startedAt: null, lessonKey }
        : { ...t, running: true, startedAt: now, lessonKey };
      saveTimer(next);
      return next;
    });
  };

  const reset = () => {
    setTimer(() => {
      const next = { ...EMPTY, lessonKey };
      saveTimer(next);
      return next;
    });
  };

  /** 调用那一刻的累计用时（点「生成」时定格用；不要在 render 里用它显示，会不准） */
  const elapsedMsNow = () => timer.accumulated + (timer.running && timer.startedAt ? Math.max(0, Date.now() - timer.startedAt) : 0);

  return { timer, toggle, reset, elapsedMsNow, hasElapsed: timer.running || timer.accumulated > 0 };
}
