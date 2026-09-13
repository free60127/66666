/**
 * normalizeResult 单测 —— 重点是「went → went」这类无意义对照的清理。
 *
 * 为什么要在前端也过滤一遍（服务端已经过滤了）：
 * 用户看到的那条结果是**早就存下来的**（本机缓存 / 历史 / 分享链接），
 * 服务端过滤只能保证"以后新生成的"干净；前端过滤才能让**已有的旧结果**
 * 一刷新就正常，而不用重新花一次 AI 调用。
 */
import { describe, it, expect } from 'vitest';
import { normalizeResult } from '../../src/resultData.js';

const f = (over = {}) => ({ category: '时态', level: 'study', from: 'went', to: 'went', explanation: '一般过去时 went 正确', ...over });
const wrap = (findings, overall = {}) => ({
  title: 't', chinese: '上星期我去看戏。', draft: 'Last week I went to see a play.',
  ai: 'Last week I went to the theatre.', original: 'Last week I went to the theatre.',
  overall: { score: 72, issues: 99, ...overall },
  sentences: [{ cn: '上星期我去看戏。', findings }],
});

describe('normalizeResult：过滤无意义对照', () => {
  it('★ 用户实测的那条：went → went 被过滤掉', () => {
    const r = normalizeResult(wrap([
      f(),                                                                   // went → went（噪音）
      f({ category: '地道程度', level: 'improve', from: 'went to see a play', to: 'went to the theatre' }), // 有效
    ]));
    expect(r.sentences[0].findings).toHaveLength(1);
    expect(r.sentences[0].findings[0].to).toBe('went to the theatre');
  });

  it('只差空白的条目也被过滤', () => {
    const r = normalizeResult(wrap([f({ from: 'search  my bag ', to: 'search my bag' })]));
    expect(r.sentences[0].findings).toHaveLength(0);
  });

  it('★ 但大小写差异要保留（那是真的批改点，不能误删）', () => {
    const r = normalizeResult(wrap([f({ category: '标点', level: 'error', from: 'hello', to: 'Hello' })]));
    expect(r.sentences[0].findings).toHaveLength(1);
  });

  it('★ 句末标点差异要保留', () => {
    const r = normalizeResult(wrap([f({ category: '标点', level: 'error', from: 'I went to the theatre', to: 'I went to the theatre.' })]));
    expect(r.sentences[0].findings).toHaveLength(1);
  });

  it('缺 from 或 to 的条目被过滤', () => {
    const r = normalizeResult(wrap([f({ from: '' }), f({ to: '   ' })]));
    expect(r.sentences[0].findings).toHaveLength(0);
  });

  it('过滤后重算问题总数（否则标题说 99 处、下面只列 1 条）', () => {
    const r = normalizeResult(wrap([
      f(), f({ from: 'a', to: 'a' }),
      f({ from: 'search my bag', to: 'search for my bag', level: 'error' }),
    ]));
    expect(r.overall.issues).toBe(1);
  });

  it('没有句子时保留模型给的 issues（不硬改成 0）', () => {
    const r = normalizeResult({ overall: { issues: 12 }, sentences: [] });
    expect(r.overall.issues).toBe(12);
  });
});

describe('normalizeResult：原有的类型规整不受影响', () => {
  it('dimensions 只留字符串、synonyms 只留非空', () => {
    const r = normalizeResult(wrap([f({ from: 'a', to: 'b', dimensions: ['语域', 42, null], synonyms: [{ word: 'x' }, null] })]));
    expect(r.sentences[0].findings[0].dimensions).toEqual(['语域']);
    expect(r.sentences[0].findings[0].synonyms).toEqual([{ word: 'x' }]);
  });

  it('旧结果缺少 dimensions / synonyms 时补成空数组', () => {
    const r = normalizeResult(wrap([f({ from: 'a', to: 'b' })]));
    expect(r.sentences[0].findings[0].dimensions).toEqual([]);
    expect(r.sentences[0].findings[0].synonyms).toEqual([]);
  });

  it('非对象输入返回 null', () => {
    expect(normalizeResult(null)).toBeNull();
    expect(normalizeResult('x')).toBeNull();
  });

  it('sentences 里混入 null / 字符串时被丢掉', () => {
    const r = normalizeResult({ sentences: [null, 'x', { cn: '好句子', findings: [] }] });
    expect(r.sentences).toHaveLength(1);
  });
});
