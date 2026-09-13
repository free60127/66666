/**
 * useModals 的键盘可达性 + 焦点行为单测。
 *
 * 回归的 bug（用户实测反馈）：在「AI 生成训练素材」弹窗里打中文，
 * 输入法刚组合出第一个字母就"闪退"，字母直接以英文落进输入框。
 *
 * 根因：调用方传的是内联箭头函数（每次渲染身份都变），它出现在 effect 依赖里 →
 * effect 每次重渲染都重跑 → 里面的"把焦点送进弹窗"把焦点从 textarea 抢到关闭按钮 →
 * 输入法组合被打断。所以这里的关键断言是：**父组件重渲染后，焦点不能被抢走**。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React, { useState } from 'react';
import { render, screen, fireEvent, act, cleanup } from '@testing-library/react';
import { useModals } from '../../src/hooks/useModals.js';

/** 复刻真实调用方式：closeAuth 用内联箭头（旧代码就是这样传的） */
function Harness() {
  const m = useModals({ closeAuth: () => {} });
  const [, force] = useState(0);
  return (
    <div>
      <button onClick={() => m.setMaterialOpen(true)}>打开素材弹窗</button>
      <button onClick={() => force((n) => n + 1)}>触发重渲染</button>
      {m.materialOpen ? (
        <div className="modal" ref={(el) => { m.modalRefs.current.material = el; }} role="dialog">
          <button className="icon-btn" aria-label="关闭">关闭</button>
          <label>主题<textarea placeholder="主题" /></label>
          <button>生成素材</button>
        </div>
      ) : null}
    </div>
  );
}

const tick = async (ms = 60) => { await act(async () => { await new Promise((r) => setTimeout(r, ms)); }); };

beforeEach(() => { vi.useRealTimers(); });
afterEach(() => cleanup());

describe('useModals：打开弹窗后的焦点', () => {
  it('焦点落在输入控件上，而不是第一个按钮（关闭）', async () => {
    render(<Harness />);
    fireEvent.click(screen.getByText('打开素材弹窗'));
    await tick();
    expect(document.activeElement.tagName).toBe('TEXTAREA');
  });

  it('★ 父组件重渲染后焦点不被抢走（就是那个打断中文输入法的 bug）', async () => {
    render(<Harness />);
    fireEvent.click(screen.getByText('打开素材弹窗'));
    await tick();
    const ta = screen.getByPlaceholderText('主题');
    ta.focus();
    expect(document.activeElement).toBe(ta);

    // 用户敲一个字母 → setState → 父组件重渲染（旧代码在这里把焦点抢走了）
    fireEvent.click(screen.getByText('触发重渲染'));
    await tick();
    expect(document.activeElement).toBe(ta);

    // 连续多次重渲染（例如页面里的计时器每秒 tick）也不能抢
    for (let i = 0; i < 3; i += 1) {
      fireEvent.click(screen.getByText('触发重渲染'));
      await tick();
      expect(document.activeElement).toBe(ta);
    }
  });

  it('用户已经在弹窗内时，打开动作不会再把焦点挪走', async () => {
    render(<Harness />);
    fireEvent.click(screen.getByText('打开素材弹窗'));
    await tick();
    const ta = screen.getByPlaceholderText('主题');
    ta.focus();
    fireEvent.click(screen.getByText('触发重渲染'));
    await tick();
    expect(document.activeElement).toBe(ta);
  });
});

describe('useModals：Esc 与 Tab', () => {
  it('Esc 关闭弹窗', async () => {
    render(<Harness />);
    fireEvent.click(screen.getByText('打开素材弹窗'));
    await tick();
    act(() => { fireEvent.keyDown(document, { key: 'Escape' }); });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('★ 输入法组合中的 Esc（取消候选词）不关弹窗', async () => {
    render(<Harness />);
    fireEvent.click(screen.getByText('打开素材弹窗'));
    await tick();
    act(() => { fireEvent.keyDown(document, { key: 'Escape', isComposing: true }); });
    expect(screen.queryByRole('dialog')).not.toBeNull();
    // keyCode 229 是另一套标记（部分浏览器只给这个），同样不能关
    act(() => { fireEvent.keyDown(document, { key: 'Escape', keyCode: 229 }); });
    expect(screen.queryByRole('dialog')).not.toBeNull();
    // 正常 Esc 仍然能关
    act(() => { fireEvent.keyDown(document, { key: 'Escape' }); });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('Tab 在弹窗内循环（不移出弹窗）', async () => {
    render(<Harness />);
    fireEvent.click(screen.getByText('打开素材弹窗'));
    await tick();
    const btns = screen.getAllByRole('button').filter((b) => b.closest('[role="dialog"]'));
    const last = btns[btns.length - 1];
    last.focus();
    act(() => { fireEvent.keyDown(document, { key: 'Tab' }); });
    // 从最后一个 Tab → 回到弹窗内第一个可聚焦元素，不应跑到弹窗外的按钮上
    expect(document.activeElement.closest('[role="dialog"]')).not.toBeNull();
  });
});
