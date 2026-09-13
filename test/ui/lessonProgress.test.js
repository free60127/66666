/**
 * 逐课进度（lessonProgress）单测。
 *
 * 为什么值得测：这个模块决定"我完成了多少课"这个数字 —— 算错了会让用户
 * 白练（明明做了却不打星）或者虚高（只做一遍显示做了三次），两种都会直接打击学习动力。
 * 另外它跨设备同步，合并规则写错会永久污染数据。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  loadProgress, saveProgress, recordAttempt, progressOf, summarize,
  mergeProgress, doneSet, prune, PROGRESS_KEY, PROGRESS_MAX,
} from '../../src/lessonProgress.js';

beforeEach(() => localStorage.clear());

describe('recordAttempt', () => {
  it('第一次完成：n=1、best=分数', () => {
    const m = recordAttempt({}, 'lesson:2-18', { score: 72, durationMs: 60000, at: 1000 });
    expect(m['lesson:2-18']).toEqual({ n: 1, best: 72, last: 72, at: 1000, ms: 60000 });
  });

  it('答得更高时刷新 best，更低时保留 best', () => {
    let m = recordAttempt({}, 'lesson:2-18', { score: 72, at: 1 });
    m = recordAttempt(m, 'lesson:2-18', { score: 86, at: 2 });
    expect(m['lesson:2-18'].best).toBe(86);
    expect(m['lesson:2-18'].last).toBe(86);
    m = recordAttempt(m, 'lesson:2-18', { score: 60, at: 3 });
    expect(m['lesson:2-18'].best).toBe(86);   // 最好成绩不被拉低
    expect(m['lesson:2-18'].last).toBe(60);
    expect(m['lesson:2-18'].n).toBe(3);
  });

  it('累计用时相加', () => {
    let m = recordAttempt({}, 'lesson:2-18', { score: 70, durationMs: 60000, at: 1 });
    m = recordAttempt(m, 'lesson:2-18', { score: 80, durationMs: 90000, at: 2 });
    expect(m['lesson:2-18'].ms).toBe(150000);
  });

  it('不修改传入的对象（纯函数）', () => {
    const before = {};
    const after = recordAttempt(before, 'lesson:2-18', { score: 70, at: 1 });
    expect(before).toEqual({});
    expect(after['lesson:2-18'].n).toBe(1);
  });

  it('自由模式与空 key 不记录（成绩不属于任何一课）', () => {
    expect(recordAttempt({}, 'free', { score: 90 })).toEqual({});
    expect(recordAttempt({}, '', { score: 90 })).toEqual({});
    expect(recordAttempt({}, null, { score: 90 })).toEqual({});
  });

  it('分数缺失/异常时按 0 处理，不产生 NaN', () => {
    const m = recordAttempt({}, 'lesson:2-18', { score: 'abc', at: 1 });
    expect(Number.isFinite(m['lesson:2-18'].best)).toBe(true);
    expect(m['lesson:2-18'].best).toBe(0);
  });
});

describe('progressOf', () => {
  it('没练过返回 null', () => {
    expect(progressOf({}, 'lesson:2-18')).toBeNull();
  });
  it('练过返回记录', () => {
    const m = recordAttempt({}, 'lesson:2-18', { score: 72, at: 1 });
    expect(progressOf(m, 'lesson:2-18').n).toBe(1);
  });
  it('n=0 的脏记录不算完成', () => {
    expect(progressOf({ 'lesson:2-18': { n: 0, best: 0, last: 0, at: 0, ms: 0 } }, 'lesson:2-18')).toBeNull();
  });
});

describe('summarize / doneSet', () => {
  it('统计一册里练过几课', () => {
    let m = recordAttempt({}, 'lesson:2-18', { score: 72, at: 1 });
    m = recordAttempt(m, 'lesson:2-19', { score: 80, at: 2 });
    const s = summarize(m, ['lesson:2-18', 'lesson:2-19', 'lesson:2-20']);
    expect(s).toEqual({ done: 2, total: 3, attempts: 2, best: 80 });
  });

  it('同一课练多次：done 仍算 1 课，attempts 累加', () => {
    let m = recordAttempt({}, 'lesson:2-18', { score: 60, at: 1 });
    m = recordAttempt(m, 'lesson:2-18', { score: 70, at: 2 });
    m = recordAttempt(m, 'lesson:2-18', { score: 80, at: 3 });
    const s = summarize(m, ['lesson:2-18']);
    expect(s.done).toBe(1);
    expect(s.attempts).toBe(3);
    expect(s.best).toBe(80);
  });

  it('doneSet 只收完成的课', () => {
    const m = recordAttempt({ 'lesson:2-20': { n: 0, best: 0, last: 0, at: 0, ms: 0 } }, 'lesson:2-18', { score: 72, at: 1 });
    expect([...doneSet(m)]).toEqual(['lesson:2-18']);
  });
});

describe('mergeProgress（跨设备）', () => {
  it('计数取 max 而不是相加（避免同一课被两边各算一次）', () => {
    const a = { 'lesson:2-18': { n: 3, best: 72, last: 72, at: 100, ms: 1000 } };
    const b = { 'lesson:2-18': { n: 3, best: 86, last: 86, at: 200, ms: 2000 } };
    const m = mergeProgress(a, b);
    expect(m['lesson:2-18'].n).toBe(3);      // 不是 6
    expect(m['lesson:2-18'].best).toBe(86);  // 最高分要保留
    expect(m['lesson:2-18'].last).toBe(86);  // 取更新的那次
    expect(m['lesson:2-18'].at).toBe(200);
  });

  it('两边各有的课都保留', () => {
    const a = { 'lesson:2-18': { n: 1, best: 70, last: 70, at: 1, ms: 0 } };
    const b = { 'lesson:2-19': { n: 1, best: 80, last: 80, at: 2, ms: 0 } };
    expect(Object.keys(mergeProgress(a, b)).sort()).toEqual(['lesson:2-18', 'lesson:2-19']);
  });

  it('一边为空时原样返回另一边', () => {
    const a = { 'lesson:2-18': { n: 2, best: 70, last: 70, at: 1, ms: 0 } };
    expect(mergeProgress(a, {})['lesson:2-18'].n).toBe(2);
    expect(mergeProgress({}, a)['lesson:2-18'].n).toBe(2);
  });

  it('脏数据不会污染结果', () => {
    const m = mergeProgress({ 'lesson:2-18': { n: 1, best: 70, last: 70, at: 1, ms: 0 } }, { bad: null, 'lesson:2-19': 'x' });
    expect(Object.keys(m)).toEqual(['lesson:2-18']);
  });
});

describe('load / save / prune', () => {
  it('存下来能读回来', () => {
    const m = recordAttempt({}, 'lesson:2-18', { score: 72, at: 1 });
    saveProgress(m);
    expect(loadProgress()['lesson:2-18'].best).toBe(72);
  });

  it('存储里是坏 JSON 时不崩、返回空对象', () => {
    localStorage.setItem(PROGRESS_KEY, '{坏');
    expect(loadProgress()).toEqual({});
  });

  it('超上限时只留最近完成的', () => {
    const big = {};
    for (let i = 0; i < PROGRESS_MAX + 10; i += 1) big['lesson:2-' + i] = { n: 1, best: 1, last: 1, at: i, ms: 0 };
    const p = prune(big);
    expect(Object.keys(p)).toHaveLength(PROGRESS_MAX);
    expect(p['lesson:2-' + (PROGRESS_MAX + 9)]).toBeTruthy(); // 最新的那条在
    expect(p['lesson:2-0']).toBeUndefined();                  // 最旧的被淘汰
  });
});
