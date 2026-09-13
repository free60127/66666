import React, { useEffect, useState } from 'react';
import { ArrowUp } from 'lucide-react';

/**
 * 回到顶部。
 *
 * 设计取舍：**滚过一屏才出现，滚回顶部自动消失** —— 结果页有 8 屏长，但常驻一个悬浮按钮
 * 又会挤占内容（用户反馈过固定元素太挤），所以只在"确实需要它"的时候出现。
 *
 * 为什么用捕获阶段监听 scroll：滚动容器在两种形态下不是同一个 ——
 * 桌面端滚的是 .editor / .result 内部容器，手机端是整页滚动（见 styles.css 的 max-width:900px）。
 * document 上的捕获监听（第三个参数 true）能一次覆盖这两种，不必分别绑定。
 */
const SHOW_AFTER_PX = 400;

export default function BackToTop() {
  const [show, setShow] = useState(false);

  useEffect(() => {
    const readScrollTop = (e) => {
      const t = e && e.target;
      // 整页滚动时事件目标是 document（或 documentElement），否则是内部滚动容器
      if (!t || t === document || t === document.documentElement || t === document.body || t === window) {
        return window.scrollY || document.documentElement.scrollTop || 0;
      }
      return t.scrollTop || 0;
    };
    const onScroll = (e) => setShow(readScrollTop(e) > SHOW_AFTER_PX);
    document.addEventListener('scroll', onScroll, true);
    onScroll(); // 初始进来可能已经是滚动状态（比如从分享链接恢复）
    return () => document.removeEventListener('scroll', onScroll, true);
  }, []);

  if (!show) return null;

  const toTop = () => {
    const box = document.querySelector('.editor, .result');
    if (box) box.scrollTo({ top: 0, behavior: 'smooth' });
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  return (
    <button type="button" className="back-to-top" onClick={toTop} aria-label="回到顶部" title="回到顶部">
      <ArrowUp size={18} />
    </button>
  );
}
