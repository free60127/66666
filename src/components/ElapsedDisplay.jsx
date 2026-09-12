import { useEffect, useState } from 'react';
import { formatDuration } from '../format.js';

/**
 * 计时显示（叶子组件）。
 * 原来"当前时刻"是 App 的状态，计时中每秒 setState 会让整个 App 重渲染一次
 * （几十个 useState + 收藏筛选 + 全部句子卡片）。拆成叶子后只有它自己每秒重渲染。
 */
export default /**
 * 独立的计时显示组件。
 * 原来"当前时刻"是 App 的状态，计时中每秒 setState 会让整个 App 重渲染一次
 * （55 个 useState + 收藏筛选 + 全部句子卡片/DraftText）。拆成叶子组件后只有它自己每秒重渲染。
 */
function ElapsedDisplay({ timer }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!timer.running || !timer.startedAt) return undefined;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [timer.running, timer.startedAt]);
  const ms = timer.accumulated + (timer.running && timer.startedAt ? Math.max(0, now - timer.startedAt) : 0);
  return <>{formatDuration(ms)}</>;
}
