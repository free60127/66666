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
 *
 * ⚠️ 但捕获监听会收到**所有**容器的滚动事件，包括侧栏课表和弹窗里的列表。
 * 实测：在侧栏课表里滚 600px → 右下角浮出「回到顶部」（z-index 45 还压在侧栏之上）；
 * 关掉侧栏它也不会消失（要等下一次 scroll 事件才复位）；桌面端它被遮罩压住，
 * 点下去命中的是遮罩 —— 把弹窗关掉了。所以这里只认「页面级滚动容器」。
 */
const SHOW_AFTER_PX = 400;

/** 只有整页滚动、或主内容区（.editor / .result）的滚动才算数 */
function isPageScroller(target) {
  if (!target || target === document || target === window) return true;
  if (target === document.documentElement || target === document.body) return true;
  const el = target;
  if (el.nodeType !== 1) return false;
  return el.classList?.contains('editor') || el.classList?.contains('result');
}

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
    const onScroll = (e) => {
      const t = e && e.target;
      // 弹窗打开时一律不显示：按钮在遮罩下面（z-index 45 < 50），点它只会把弹窗关掉
      if (document.querySelector('.modal-mask')) { setShow(false); return; }
      if (!isPageScroller(t)) return; // 侧栏课表 / 弹窗列表的滚动不算
      setShow(readScrollTop(e) > SHOW_AFTER_PX);
    };
    document.addEventListener('scroll', onScroll, true);
    onScroll(); // 初始进来可能已经是滚动状态（比如从分享链接恢复）
    // 弹窗开合本身不产生 scroll 事件，得单独听一次，否则按钮会一直挂在遮罩下面
    const observer = new MutationObserver(onScroll);
    observer.observe(document.body, { childList: true, subtree: true });
    return () => {
      document.removeEventListener('scroll', onScroll, true);
      observer.disconnect();
    };
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
