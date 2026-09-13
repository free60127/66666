/**
 * 连续学习天数（streak）单测。
 *
 * 为什么值得测：这个数字直接决定用户信不信它 ——
 *  · 时区算错（用 UTC）→ 晚上练的人被判成"昨天"，连续天数凭空断掉；
 *  · 今天还没练就显示 0 → 用户一早打开看到"连续 0 天"，其实他还没开始；
 *  · 跨月 / 跨年 / 闰年边界算错 → 断掉的连续被接上，或连续的被断开。
 * 这些都是"看一眼代码觉得没问题、用起来才会发现"的地方。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  dayKey, shiftDay, loadDays, saveDays, normalizeDays, recordDay,
  currentStreak, longestStreak, mergeDays, summarizeStreak, DAYS_KEY, DAYS_MAX,
} from '../../src/studyStreak.js';

beforeEach(() => localStorage.clear());

describe('dayKey / shiftDay', () => {
  it('用本地日期，不是 UTC', () => {
    // 本地 2026-09-13 23:30：在 UTC+8 时若用 toISOString 会变成 09-13T15:30 → 仍是 13 号，
    // 但 UTC-5 的晚上就会跨天。这里断言"结果等于本地年月日"这一不变式。
    const d = new Date(2026, 8, 13, 23, 30);
    expect(dayKey(d)).toBe('2026-09-13');
  });

  it('月 / 日补零', () => {
    expect(dayKey(new Date(2026, 0, 5))).toBe('2026-01-05');
  });

  it('跨月：9-01 往前一天 = 8-31', () => {
    expect(shiftDay('2026-09-01', -1)).toBe('2026-08-31');
  });

  it('跨年：1-01 往前一天 = 上一年 12-31', () => {
    expect(shiftDay('2026-01-01', -1)).toBe('2025-12-31');
  });

  it('闰年：2028-03-01 往前一天 = 02-29', () => {
    expect(shiftDay('2028-03-01', -1)).toBe('2028-02-29');
  });

  it('非法输入返回空串', () => {
    expect(shiftDay('2026-9-1', -1)).toBe('');
    expect(dayKey('不是日期')).toBe('');
  });
});

describe('recordDay / normalizeDays', () => {
  it('记一天，倒序存放', () => {
    let d = recordDay([], '2026-09-13');
    d = recordDay(d, '2026-09-12');
    expect(d).toEqual(['2026-09-13', '2026-09-12']);
  });

  it('同一天练多次只算一天', () => {
    let d = recordDay([], '2026-09-13');
    d = recordDay(d, '2026-09-13');
    expect(d).toEqual(['2026-09-13']);
  });

  it('已是同一天的数组原样返回（便于 React 判等）', () => {
    const d = ['2026-09-13'];
    expect(recordDay(d, '2026-09-13')).toBe(d);
  });

  it('丢掉非法日期并去重', () => {
    expect(normalizeDays(['2026-09-13', 'x', '2026-09-13', '', null, 42])).toEqual(['2026-09-13']);
  });

  it('超上限只留最近的天', () => {
    const many = Array.from({ length: DAYS_MAX + 20 }, (_, i) => shiftDay('2030-01-01', -i));
    const out = normalizeDays(many);
    expect(out).toHaveLength(DAYS_MAX);
    expect(out[0]).toBe('2030-01-01');
  });
});

describe('currentStreak', () => {
  it('没练过 = 0', () => {
    expect(currentStreak([], '2026-09-13')).toBe(0);
  });

  it('只有今天 = 1', () => {
    expect(currentStreak(['2026-09-13'], '2026-09-13')).toBe(1);
  });

  it('连续三天（含今天）= 3', () => {
    expect(currentStreak(['2026-09-13', '2026-09-12', '2026-09-11'], '2026-09-13')).toBe(3);
  });

  it('★ 今天还没练，但昨天练过 → 连续仍算（不能一早就显示 0）', () => {
    expect(currentStreak(['2026-09-12', '2026-09-11'], '2026-09-13')).toBe(2);
  });

  it('断了两天以上 → 归零', () => {
    expect(currentStreak(['2026-09-10', '2026-09-09'], '2026-09-13')).toBe(0);
  });

  it('中间断过：只数到断点', () => {
    expect(currentStreak(['2026-09-13', '2026-09-12', '2026-09-10', '2026-09-09'], '2026-09-13')).toBe(2);
  });

  it('跨月连续', () => {
    expect(currentStreak(['2026-09-01', '2026-08-31', '2026-08-30'], '2026-09-01')).toBe(3);
  });

  it('跨年连续', () => {
    expect(currentStreak(['2026-01-01', '2025-12-31'], '2026-01-01')).toBe(2);
  });
});

describe('longestStreak', () => {
  it('空 = 0', () => expect(longestStreak([])).toBe(0));
  it('找最长的那一段，而不是最近那段', () => {
    expect(longestStreak(['2026-09-13', '2026-09-12', '2026-09-08', '2026-09-07', '2026-09-06', '2026-09-05'])).toBe(4);
  });
  it('全连着就是总数', () => {
    expect(longestStreak(['2026-09-03', '2026-09-02', '2026-09-01'])).toBe(3);
  });
});

describe('mergeDays（跨设备）', () => {
  it('取并集（一天就是一天，不会重复计数）', () => {
    expect(mergeDays(['2026-09-13', '2026-09-12'], ['2026-09-12', '2026-09-11']))
      .toEqual(['2026-09-13', '2026-09-12', '2026-09-11']);
  });
  it('一边为空时原样返回另一边', () => {
    expect(mergeDays([], ['2026-09-13'])).toEqual(['2026-09-13']);
    expect(mergeDays(['2026-09-13'], null)).toEqual(['2026-09-13']);
  });
  it('脏数据被清掉', () => {
    expect(mergeDays(['bad'], ['2026-09-13', 42])).toEqual(['2026-09-13']);
  });
});

describe('summarizeStreak / 存储', () => {
  it('汇总：当前 / 最长 / 今天是否已练 / 总天数', () => {
    const s = summarizeStreak(['2026-09-13', '2026-09-12', '2026-09-05'], '2026-09-13');
    expect(s).toEqual({ current: 2, longest: 2, todayDone: true, total: 3 });
  });

  it('今天没练时 todayDone=false，但当前连续仍按昨天算', () => {
    const s = summarizeStreak(['2026-09-12', '2026-09-11'], '2026-09-13');
    expect(s.todayDone).toBe(false);
    expect(s.current).toBe(2);
  });

  it('存下来能读回来', () => {
    saveDays(['2026-09-13', '2026-09-12']);
    expect(loadDays()).toEqual(['2026-09-13', '2026-09-12']);
  });

  it('坏 JSON 不崩', () => {
    localStorage.setItem(DAYS_KEY, '{坏');
    expect(loadDays()).toEqual([]);
  });

  it('存储里混入非法值时只读回合法项', () => {
    localStorage.setItem(DAYS_KEY, JSON.stringify(['2026-09-13', 'oops', 42]));
    expect(loadDays()).toEqual(['2026-09-13']);
  });
});
