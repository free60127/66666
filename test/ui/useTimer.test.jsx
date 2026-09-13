/**
 * useTimer 单测（练习计时器）。
 *
 * 为什么值得测：计时用的是「时间戳差值」而不是 setInterval 累加 —— 后者在页面切到后台时
 * 会被浏览器节流，计时偏慢，而学习者会把用时当成"我练了多久"的真实记录。
 * 这里把三条容易写错的规则钉住：暂停/继续不丢时间、切课自动归零、刷新（同 key）保留。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';

// 等待 ms：包在 act 里，避免 React 报「未包裹的状态更新」警告
const sleep = (ms) => act(async () => { await new Promise((r) => setTimeout(r, ms)); });
import { useTimer } from '../../src/hooks/useTimer.js';

beforeEach(() => {
  localStorage.clear();
  vi.useRealTimers();
});

describe('useTimer', () => {
  it('初始状态：未运行、累计为 0', () => {
    const { result } = renderHook(() => useTimer('lesson:2-18'));
    expect(result.current.timer.running).toBe(false);
    expect(result.current.elapsedMsNow()).toBe(0);
    expect(result.current.hasElapsed).toBe(false);
  });

  it('开始后按真实时间累计（不是靠 tick 累加）', async () => {
    const { result } = renderHook(() => useTimer('lesson:2-18'));
    act(() => result.current.toggle()); // 开始
    expect(result.current.timer.running).toBe(true);
    await sleep(60);
    // 只要 > 0 就说明走的是时间戳差值；不依赖任何 1 秒 tick
    expect(result.current.elapsedMsNow()).toBeGreaterThan(40);
    expect(result.current.hasElapsed).toBe(true);
  });

  it('暂停后累计值冻结，继续后接着累加（不丢时间）', async () => {
    const { result } = renderHook(() => useTimer('lesson:2-18'));
    act(() => result.current.toggle());
    await sleep(50);
    act(() => result.current.toggle()); // 暂停
    const paused = result.current.timer.accumulated;
    expect(paused).toBeGreaterThan(0);
    await sleep(50);
    expect(result.current.elapsedMsNow()).toBe(paused); // 暂停期间不再增长
    act(() => result.current.toggle()); // 继续
    await sleep(50);
    expect(result.current.elapsedMsNow()).toBeGreaterThan(paused);
  });

  it('reset 归零', async () => {
    const { result } = renderHook(() => useTimer('lesson:2-18'));
    act(() => result.current.toggle());
    await sleep(30);
    act(() => result.current.reset());
    expect(result.current.timer.accumulated).toBe(0);
    expect(result.current.timer.running).toBe(false);
    expect(result.current.hasElapsed).toBe(false);
  });

  it('切换课文自动归零（不同课的用时不能混在一起）', async () => {
    const { result, rerender } = renderHook(({ key }) => useTimer(key), { initialProps: { key: 'lesson:2-18' } });
    act(() => result.current.toggle());
    await sleep(30);
    expect(result.current.elapsedMsNow()).toBeGreaterThan(0);
    rerender({ key: 'lesson:2-19' });
    await sleep(10);
    expect(result.current.timer.accumulated).toBe(0);
    expect(result.current.timer.running).toBe(false);
    expect(result.current.timer.lessonKey).toBe('lesson:2-19');
  });

  it('同一课文重新挂载（刷新页面）保留原计时', async () => {
    const first = renderHook(() => useTimer('lesson:2-18'));
    act(() => first.result.current.toggle());
    await sleep(30);
    const before = first.result.current.elapsedMsNow();
    first.unmount();
    // 模拟刷新：同一 lessonKey 重新挂载，从 localStorage 读回
    const second = renderHook(() => useTimer('lesson:2-18'));
    expect(second.result.current.timer.running).toBe(true);
    expect(second.result.current.elapsedMsNow()).toBeGreaterThanOrEqual(before);
  });

  it('localStorage 里的脏数据不会让 hook 崩', () => {
    localStorage.setItem('bt-timer', '{坏 JSON');
    const { result } = renderHook(() => useTimer('lesson:2-18'));
    expect(result.current.timer.accumulated).toBe(0);
    expect(result.current.timer.running).toBe(false);
  });
});
