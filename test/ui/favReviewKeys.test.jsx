/**
 * 复习面板的键盘快捷键（空格翻面、1/2/3 = 忘了/一般/简单）。
 *
 * 为什么值得测：这是"手不离键盘"的交互，坏掉的方式都很隐蔽 ——
 * 空格没翻成面、按 1 却记成"简单"（评分直接写进 SM-2 排期，错一次要歪好几天）、
 * 复习结束后还在后台吃按键、输入法组合里的数字选词被当成评分。
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, createEvent, cleanup } from '@testing-library/react';
import { FavReviewPanel } from '../../src/components/ResultSheet/Review.jsx';

const items = [
  { id: 'a', kind: 'finding', title: 'swerve the ship', body: 'swing the speedboat round' },
  { id: 'b', kind: 'vocab', title: 'swing round', body: '转弯' },
];

const session = (over = {}) => ({ ids: ['a', 'b'], index: 0, revealed: false, reviewed: 0, tally: { forgot: 0, normal: 0, easy: 0 }, ...over });

function setup(over = {}) {
  const props = { session: session(over), items, onReveal: vi.fn(), onGrade: vi.fn(), onSkip: vi.fn(), onExit: vi.fn() };
  render(<FavReviewPanel {...props} />);
  return props;
}

/** 敲一个键，返回事件对象（用来断言 preventDefault 有没有生效） */
const press = (key, init = {}) => {
  const e = createEvent.keyDown(document, { key, ...init });
  fireEvent(document, e);
  return e;
};

afterEach(() => cleanup());

describe('复习面板：空格翻面', () => {
  it('空格 = 显示答案，并拦掉默认行为（否则页面会跟着滚一格）', () => {
    const p = setup();
    const e = press(' ');
    expect(p.onReveal).toHaveBeenCalledTimes(1);
    expect(e.defaultPrevented).toBe(true);
  });

  it('已翻面时再按空格不再重复翻（评分按钮此刻才是主角）', () => {
    const p = setup({ revealed: true });
    press(' ');
    expect(p.onReveal).not.toHaveBeenCalled();
    expect(p.onGrade).not.toHaveBeenCalled();
  });
});

describe('复习面板：1/2/3 评分', () => {
  it('1 → 忘了、2 → 一般、3 → 简单（顺序与界面上的按钮一致）', () => {
    const p = setup({ revealed: true });
    press('1'); press('2'); press('3');
    expect(p.onGrade.mock.calls.map((c) => c[0])).toEqual(['forgot', 'normal', 'easy']);
  });

  it('没翻面时数字键不评分（答案还没看，评分无从谈起）', () => {
    const p = setup();
    press('1'); press('2'); press('3');
    expect(p.onGrade).not.toHaveBeenCalled();
  });

  it('小键盘的 1/2/3 同样有效（NumLock 关掉时 e.key 是 End 之类，只能靠 e.code 认）', () => {
    const p = setup({ revealed: true });
    press('End', { code: 'Numpad1' });
    expect(p.onGrade).toHaveBeenCalledWith('forgot');
  });

  it('带修饰键的按键让给浏览器（Ctrl+1 不应该顺手评个分）', () => {
    const p = setup({ revealed: true });
    press('1', { ctrlKey: true });
    press('2', { metaKey: true });
    press('3', { altKey: true });
    expect(p.onGrade).not.toHaveBeenCalled();
  });
});

describe('复习面板：不该抢的按键', () => {
  it('输入法组合中的按键全部放过（中文候选词的数字选词不能被吃掉）', () => {
    const p = setup();
    press(' ', { keyCode: 229 });
    press('1', { isComposing: true });
    expect(p.onReveal).not.toHaveBeenCalled();
    expect(p.onGrade).not.toHaveBeenCalled();
  });

  it('焦点在输入框里时不抢键', () => {
    const p = setup();
    const input = document.createElement('input');
    document.body.appendChild(input);
    fireEvent.keyDown(input, { key: ' ', bubbles: true });
    expect(p.onReveal).not.toHaveBeenCalled();
    input.remove();
  });

  it('复习已完成（队列走完）后，按键不再触发任何回调', () => {
    const p = setup({ index: 2, reviewed: 2 });
    press(' ');
    press('1');
    expect(p.onReveal).not.toHaveBeenCalled();
    expect(p.onGrade).not.toHaveBeenCalled();
  });
});

describe('复习面板：快捷键提示', () => {
  it('键帽直接写在按钮上（不写出来就没人会去试）', () => {
    setup();
    expect(screen.getByText('显示答案').textContent).toContain('空格');
    cleanup();
    setup({ revealed: true });
    expect(screen.getByRole('button', { name: /忘了/ }).textContent).toContain('1');
    expect(screen.getByRole('button', { name: /一般/ }).textContent).toContain('2');
    expect(screen.getByRole('button', { name: /简单/ }).textContent).toContain('3');
  });
});
