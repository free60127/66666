import { describe, expect, it, beforeEach } from 'vitest';
import { loadDraft, saveDraft, clearDraft, draftAgeText } from '../../src/draftBox.js';

const snap = (draft, extra = {}) => ({ title: 'Lesson 2 · My Family', chinese: '中文', draft, manualOriginal: '原文', generatedOriginal: '', materialKeywords: [], direction: 'cn2en', ...extra });

describe('草稿本（draftBox）', () => {
  beforeEach(() => localStorage.clear());

  it('保存后按课文键读回，初稿为空时不写入（保留旧草稿，程序性清空不覆盖）', () => {
    saveDraft('lesson:10-2', snap('This is a photo...'));
    expect(loadDraft('lesson:10-2')?.draft).toBe('This is a photo...');
    saveDraft('lesson:10-2', snap('   ')); // 空白初稿：跳过
    expect(loadDraft('lesson:10-2')?.draft).toBe('This is a photo...');
    clearDraft('lesson:10-2');
    expect(loadDraft('lesson:10-2')).toBeNull();
  });

  it('没有草稿的课文返回 null，不影响其他课文', () => {
    saveDraft('lesson:10-2', snap('A'));
    saveDraft('lesson:10-3', snap('B'));
    clearDraft('lesson:10-2');
    expect(loadDraft('lesson:10-2')).toBeNull();
    expect(loadDraft('lesson:10-3')?.draft).toBe('B');
    expect(loadDraft('free')).toBeNull();
  });

  it('超过 30 篇时淘汰较早写入的（LRU），最新一篇必然保留', () => {
    for (let i = 0; i < 32; i += 1) saveDraft(`lesson:10-${i}`, snap(`草稿 ${i}`));
    expect(loadDraft('lesson:10-31')?.draft).toBe('草稿 31');
    const all = JSON.parse(localStorage.getItem('bt-drafts'));
    expect(Object.keys(all).length).toBeLessThanOrEqual(30);
    expect(all['lesson:10-31']).toBeTruthy();
  });

  it('draftAgeText 分档文案', () => {
    expect(draftAgeText(Date.now() - 5000)).toBe('刚刚');
    expect(draftAgeText(Date.now() - 5 * 60000)).toBe('5 分钟前');
    expect(draftAgeText(Date.now() - 3 * 3600000)).toBe('3 小时前');
    expect(draftAgeText(Date.now() - 2 * 86400000)).toBe('2 天前');
  });
});
