import { describe, expect, it } from 'vitest';
import { exportDate, reportBlocks, reportFilename, safeFilename, uniqueFilename } from '../../src/homeworkExport.js';

describe('作业 PDF 文件名与内容', () => {
  it('用北京时间提交日期，保留零分，缺少评分不伪造分数', () => {
    const at = Date.parse('2026-10-09T17:00:00Z');
    expect(exportDate(at)).toBe('2026-10-10');
    expect(reportFilename({ name: '王同学', score: 0, at })).toBe('王同学_0_2026-10-10.pdf');
    expect(reportFilename({ name: '王同学', score: null, at })).toContain('_未评分_');
    expect(exportDate('invalid')).toBe('日期未知');
  });
  it('中文文件名安全，同名同分同日不覆盖，防止路径和 Windows 保留名', () => {
    expect(safeFilename('../王/同学:*')).not.toMatch(/[/:*]/);
    expect(safeFilename('CON')).toBe('_CON');
    expect(safeFilename('   ')).toBe('未命名');
    const used = new Set();
    expect(uniqueFilename('王同学_88_2026-10-10.pdf', used)).toBe('王同学_88_2026-10-10.pdf');
    expect(uniqueFilename('王同学_88_2026-10-10.pdf', used)).toBe('王同学_88_2026-10-10_2.pdf');
  });
  it('保留教师评语、双语材料、逐句错因和拓展项，英译汉标签不串位', () => {
    const report = { name: '同学', studentNo: '301', score: 88, at: Date.now(), result: {
      direction: 'en2cn', chinese: 'English source', draft: '学生译文', ai: '润色译文', original: '参考译文',
      teacherComments: [{ teacher: '教师', text: '保留完整评语' }],
      overall: { summary: '总结', scoreBreakdown: [{ label: '准确性', score: 18, max: 20 }], advice: ['下一次建议'] },
      sentences: [{ cn: 'English sentence', draft: '原译', ai: '改译', original: '参考', findings: [{
        level: 'error', category: '搭配', from: 'a', to: 'b', explanation: '完整解析',
        examples: [{ en: 'Example', cn: '例句翻译' }], synonyms: [{ word: 'alternative', usage: '用法辨析' }],
      }] }], vocabularyNotes: [{ word: 'hello', morphology: { family: '同根信息' } }],
      idiomHighlights: [{ idiom: 'idiom', explanation: '习语解释' }], bonusExpressions: ['加分内容'],
    } };
    const blocks = reportBlocks(report, '班级', '作业');
    const output = blocks.map((b) => b.text).join('\n');
    for (const value of ['保留完整评语', 'English source', '学生译文', '完整解析', '例句翻译', '用法辨析', '同根信息', '习语解释', '加分内容']) expect(output).toContain(value);
    expect(blocks.find((b) => b.text === '英文原文')?.kind).toBe('section');
    expect(output).not.toContain('[object Object]');
  });
});
