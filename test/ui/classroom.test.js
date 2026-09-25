import { describe, expect, it } from 'vitest';
import { pendingAssignments } from '../../src/classroom.js';

describe('班级作业进站提醒', () => {
  it('只提醒未提交、未截止且仍开放的作业，并按截止时间排序', () => {
    const now = 1000;
    const dashboard = {
      class: { id: 'class-1', name: '一班', archivedAt: 0 },
      student: { subs: [{ hwId: 'done' }] },
      homeworks: [
        { id: 'later', title: '后截止', dueAt: 3000, closedAt: 0 },
        { id: 'done', title: '已完成', dueAt: 3000, closedAt: 0 },
        { id: 'expired', title: '已截止', dueAt: 1000, closedAt: 0 },
        { id: 'closed', title: '已结束', dueAt: 3000, closedAt: 900 },
        { id: 'first', title: '先截止', dueAt: 2000, closedAt: 0 },
      ],
    };
    expect(pendingAssignments([dashboard], now).map((task) => task.id)).toEqual(['first', 'later']);
    expect(pendingAssignments([{ ...dashboard, class: { ...dashboard.class, archivedAt: 900 } }], now)).toEqual([]);
  });
});

describe('进行中的班级任务持久化', () => {
  it('存 localStorage 且 24 小时过期——关标签页/手机切后台不再丢作业归属', async () => {
    const { activateHomework, activeHomework, clearActiveHomework } = await import('../../src/classroom.js');
    clearActiveHomework();
    expect(activeHomework()).toBeNull();
    activateHomework('class-1', 'hw-9', { title: '今日作业', prompt: '今天的天气很好。', sharedLessonId: null });
    const task = activeHomework();
    expect(task.classId).toBe('class-1');
    expect(task.hwId).toBe('hw-9');
    expect(task.title).toBe('今日作业');
    expect(task.prompt).toBe('今天的天气很好。');
    const raw = JSON.parse(localStorage.getItem('bts-active-homework'));
    expect(typeof raw.at).toBe('number');
    raw.at = Date.now() - 25 * 3600 * 1000;
    localStorage.setItem('bts-active-homework', JSON.stringify(raw));
    expect(activeHomework()).toBeNull();
    clearActiveHomework();
    expect(activeHomework()).toBeNull();
  });
});
