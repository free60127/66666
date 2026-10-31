/**
 * 难度自动切换（aiLevel）的纯逻辑测试。
 * 行为规则（用户 2026-10-31 拍板）：材料能推断等级 → 自动切换并隐藏下拉；
 * 推断不了（自由模式/自建课文库/精选自编/自定义/班级作业）→ 显示下拉。
 */
import { describe, expect, it } from 'vitest';
import { lessonAiLevel, writingTopicAiLevel, levelSelectVisible } from '../../src/aiLevel.js';

describe('课文 → 难度推断', () => {
  it('回译课文（book 10）按 section 细分', () => {
    expect(lessonAiLevel({ book: 10, section: '小初英语' })).toBe('小初');
    expect(lessonAiLevel({ book: 10, section: '高中英语' })).toBe('高考英语');
    expect(lessonAiLevel({ book: 10, section: '四六级' })).toBe('四六级');
    expect(lessonAiLevel({ book: 10, section: '考研英语' })).toBe('考研/专四');
    expect(lessonAiLevel({ book: 10, section: '专四' })).toBe('考研/专四');
    expect(lessonAiLevel({ book: 10, section: '专八' })).toBe('专八');
    expect(lessonAiLevel({ book: 10, section: 'catti二笔/三笔' })).toBe('考研/专四');
  });
  it('真题册按册号推断', () => {
    expect(lessonAiLevel({ book: 5 })).toBe('四六级');
    expect(lessonAiLevel({ book: 6 })).toBe('四六级');
    expect(lessonAiLevel({ book: 7 })).toBe('考研/专四');
    expect(lessonAiLevel({ book: 8 })).toBe('考研/专四');
    expect(lessonAiLevel({ book: 9 })).toBe('专八');
    expect(lessonAiLevel({ book: 11 })).toBe('考研/专四');
  });
  it('推断不了返回 null（自建库 / 缺字段 / 未知册）', () => {
    expect(lessonAiLevel({ book: 'my' })).toBeNull();
    expect(lessonAiLevel(null)).toBeNull();
    expect(lessonAiLevel({ book: 3, section: '神秘段落' })).toBeNull();
  });
});

describe('写作题 → 难度推断', () => {
  it('按题库 exam 来源映射', () => {
    expect(writingTopicAiLevel({ exam: 'cet4' })).toBe('四六级');
    expect(writingTopicAiLevel({ exam: 'cet6' })).toBe('四六级');
    expect(writingTopicAiLevel({ exam: 'kaoyan1' })).toBe('考研/专四');
    expect(writingTopicAiLevel({ exam: 'kaoyan2' })).toBe('考研/专四');
    expect(writingTopicAiLevel({ exam: 'tem4' })).toBe('考研/专四');
    expect(writingTopicAiLevel({ exam: 'tem8' })).toBe('专八');
  });
  it('精选自编 / 自定义 / 班级作业 / 无题 → null（显示下拉）', () => {
    expect(writingTopicAiLevel({ exam: 'own' })).toBeNull();
    expect(writingTopicAiLevel({ exam: 'custom' })).toBeNull();
    expect(writingTopicAiLevel({ id: 'assigned', exam: undefined })).toBeNull();
    expect(writingTopicAiLevel(null)).toBeNull();
  });
});

describe('难度下拉可见性', () => {
  const base = { mode: 'lesson', writingOpen: false, lessonLoading: false, hadInferredLevel: false };
  it('推断出等级就隐藏', () => {
    expect(levelSelectVisible({ ...base, inferredLevel: '考研/专四' })).toBe(false);
  });
  it('自由模式 / 自建库课文（无推断）→ 显示', () => {
    expect(levelSelectVisible({ ...base, mode: 'free' })).toBe(true);
    expect(levelSelectVisible({ ...base })).toBe(true);
  });
  it('课文加载窗口维持上一次的隐藏态，不闪烁；上一次是手动态则照常显示', () => {
    expect(levelSelectVisible({ ...base, lessonLoading: true, hadInferredLevel: true })).toBe(false);
    expect(levelSelectVisible({ ...base, lessonLoading: true })).toBe(true);
  });
  it('写作模式不受课文加载窗口影响（有无推断各自成立）', () => {
    expect(levelSelectVisible({ ...base, writingOpen: true, lessonLoading: true, hadInferredLevel: true })).toBe(true);
    expect(levelSelectVisible({ ...base, writingOpen: true, inferredLevel: '专八' })).toBe(false);
  });
});
