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
