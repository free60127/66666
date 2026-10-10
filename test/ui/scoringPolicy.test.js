import { describe, expect, it } from 'vitest';
import { SCORING_RULES, overallRepairPrompt, streamFormatRules } from '../../server/prompt.mjs';
import { localOverall } from '../../server/gradingFallback.mjs';
describe('grading rubric across generation formats', () => {
  it('does not manufacture a low score from many style suggestions if model scoring fails', () => {
    const fallback = localOverall({ sentences: [{ findings: Array.from({ length: 40 }, () => ({ level: 'improve', category: '风格' })) }] });
    expect(fallback.score).toBeNull();
    expect(fallback.summary).toContain('评分暂不可用');
    expect(fallback.summary).toContain('可选提升 40 处');
  });
  it('uses direction-specific dimensions in streaming and repair prompts', () => {
    const cn = overallRepairPrompt('en2cn');
    expect(cn.slice(0, cn.indexOf('【评分与反馈校准'))).toContain('理解准确');
    expect(cn.slice(0, cn.indexOf('【评分与反馈校准'))).not.toContain('语法与时态');
    expect(overallRepairPrompt('cn2en')).toContain('语法与时态');
    expect(streamFormatRules('en2cn')).toContain('覆盖英文原文里的每一句');
    expect(streamFormatRules('en2cn')).toContain('"label":"理解准确"');
    expect(SCORING_RULES).toContain('可选润色和学习点不扣分');
    expect(SCORING_RULES).toContain('不得为了鼓励而给真实严重错误加分');
  });
});
