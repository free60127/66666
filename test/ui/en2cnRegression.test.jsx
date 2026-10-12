import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { EN2CN_DIMENSIONS, EN2CN_MAX, normalizeEn2cnOverall } from '../../server/en2cnScoring.mjs';
import { compareWithPrevious, sameLesson } from '../../src/progress.js';
import { AI_LEVEL_KEYS, buildEn2CnUserMessage, buildOverallRepairMessage, buildGradeMessage } from '../../server/prompt.mjs';
import { favFromExpression, favFromIdiom } from '../../src/favorites.js';
import { buildLocalQuiz, favoritesToQuizPoints } from '../../src/quiz.js';
import { gradingMode } from '../../src/quizGrade.js';
import { sanitizeQuestions } from '../../server/questionShape.mjs';
import { SpeakButton, Phonetic } from '../../src/components/ResultSheet/bits.jsx';
import * as api from '../../src/api.js';
import { ResultSheet } from '../../src/components/ResultSheet/index.jsx';
import { SummaryBlock } from '../../src/components/ResultSheet/cards.jsx';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const scores = () => ({ score: 100, scoreBreakdown: EN2CN_DIMENSIONS.map((label) => ({ label, score: EN2CN_MAX[label], max: EN2CN_MAX[label], deductions: [] })) });
const data = () => ({ direction: 'en2cn', title: '测试', chinese: 'Fewer than one in five residents use it.', draft: '五分之一以上的居民使用它。', overall: scores(),
  sentences: [{ findings: [{ category: '误译', level: 'error', from: '五分之一以上', to: '不到五分之一', sourceQuote: 'Fewer than one in five', primaryDimension: '理解准确' }] }] });

describe('英译汉评分归因', () => {
  it('账本移除后，模型给出的 overall 原样展示，不做校验拦截', () => {
    const d = data();
    d.overall.score = 79; d.overall.scoreBreakdown[4].score = 4;
    expect(normalizeEn2cnOverall({ overall: d.overall }).score).toBe(79);
    const noScore = { ...d, overall: { scoreBreakdown: [] } };
    expect(normalizeEn2cnOverall(noScore.overall).scoreBreakdown).toEqual([]);
  });
  it('不同方向与不同评分规则不能制造虚假成绩提升', () => {
    expect(sameLesson({ lessonKey: 'lesson:2-1', direction: 'cn2en' }, { lessonKey: 'lesson:2-1', direction: 'en2cn' })).toBe(false);
    const current = { ...data(), lessonKey: 'lesson:2-1', overall: { ...scores(), scoringVersion: 'en2cn-evidence-v2' }, attemptTime: 200 };
    const old = { ...current, overall: { score: 58 }, attemptTime: 100 };
    expect(compareWithPrevious({ result: current, history: [{ jobId: 'old', time: 100 }], readResult: () => old, now: 300 }).score).toBeNull();
  });
  it('评分表对象形状也能归一为数组（旧数据兼容）', () => {
    const d = data();
    const map = Object.fromEntries(d.overall.scoreBreakdown.map(({ label, ...row }) => [label, row]));
    const normalized = normalizeEn2cnOverall({ overall: { ...d.overall, scoreBreakdown: map } });
    expect(Array.isArray(normalized.scoreBreakdown)).toBe(true);
    expect(normalized.score).toBe(100);
  });
  it('全部等级使用中文译法规则；复核能看到全文末尾的已译信息', () => {
    for (const level of AI_LEVEL_KEYS) {
      const prompt = buildEn2CnUserMessage({ title: 'T', source: 'S', draft: 'D', level });
      expect(prompt).not.toMatch(/5500|contribute to|with 复合|undefined|12[–-]28/);
    }
    const prompt = buildOverallRepairMessage({ direction: 'en2cn', chinese: 'a'.repeat(900) + 'SOURCE END', draft: '译'.repeat(900) + '已译的信息', findings: [] });
    expect(prompt).toContain('SOURCE END'); expect(prompt).toContain('已译的信息');
    expect(prompt).not.toContain('AI 润色版');
  });
});

describe('中文收藏与作答', () => {
  it('新旧英译汉表达能收藏、出中文翻译题，汉译英收藏仍考英文', () => {
    const raw = 'When the library opened → 图书馆开放时：按中文时间顺序表达';
    const f = favFromExpression(raw, { direction: 'en2cn', title: 'T' });
    expect(f.title).toBe('图书馆开放时');
    const q = buildLocalQuiz([f], 1).questions[0];
    expect(q.question).toContain('When the library opened'); expect(q.answerLanguage).toBe('zh');
    expect(gradingMode(q)).toBe('subjective');
    const old = { kind: 'expression', title: raw, body: '' };
    expect(buildLocalQuiz([old], 1).questions[0].answer).toBe('图书馆开放时');
    const english = favFromExpression('at first glance · 中文点拨：乍一看', { direction: 'cn2en' });
    expect(buildLocalQuiz([english], 1).questions[0].answerLanguage).toBe('en');
    expect(favoritesToQuizPoints([f, english])[0]).toContain('作答语言：中文');
    expect(favoritesToQuizPoints([f, english])[1]).toContain('作答语言：英文');
    const chineseOnly = favFromExpression('不到五分之一 · 中文点拨：表达比例', { direction: 'en2cn' });
    expect(buildLocalQuiz([chineseOnly], 1).questions[0].question).toContain('用中文表达');
    const structuredEnglish = favFromExpression({ en: 'at first glance', cn: '乍一看' }, { direction: 'cn2en' });
    expect(buildLocalQuiz([structuredEnglish], 1).questions[0].answerLanguage).toBe('en');
  });
  it('中文造句允许中文作答；英文源文提示完整时允许中文译文挖空', () => {
    const fav = favFromIdiom({ idiom: '不到五分之一', example: '不到五分之一的居民使用它。' }, { direction: 'en2cn' });
    const q = buildLocalQuiz([fav], 1).questions[0];
    expect(q.answerLanguage).toBe('zh'); expect(gradingMode(q)).toBe('subjective');
    expect(buildGradeMessage({ items: [{ ...q, index: 0, userAnswer: '不到五分之一的人来过。' }] })).toContain('中文（zh）');
    const qs = [{ question: 'Fewer than one in five use it. 译文：____的居民使用它。', answer: '不到五分之一', answerLanguage: 'zh' }];
    expect(sanitizeQuestions(qs, { drill: true }).questions).toHaveLength(1);
    expect(sanitizeQuestions([{ ...qs[0], answerLanguage: 'en' }], { drill: true }).questions).toHaveLength(0);
  });
});

describe('结果显示和朗读', () => {
  it('汉译英也等待复核后显示分数，并把完整纠错与关键错误提示保留到PDF', async () => {
    const correction = 'Only if the review passes may the project continue.';
    const result = { ...data(), direction: 'cn2en', draft: 'As long as the review passes, the project will continue.',
      overall: { ...scores(), score: 58, taskAssessment: { status: 'needs-revision', message: '存在关键条件错误，请先修正相关句。' } },
      sentences: [{ cn: '只有审查通过，项目才可能继续。', draft: 'As long as the review passes, the project will continue.',
        ai: correction, correctedSentence: correction, findings: [{ level: 'error', from: 'will continue', to: 'may continue', category: '逻辑' }] }] };
    const view = render(<ResultSheet result={{ ...result, generating: true }} history={[]} />);
    expect(screen.queryByText('58')).toBeNull();
    expect(screen.getByText('评分核对中')).toBeTruthy();
    view.rerender(<ResultSheet result={result} history={[]} />);
    expect(screen.getByText('完整纠错版')).toBeTruthy();
    expect(screen.getByText(result.overall.taskAssessment.message)).toBeTruthy();
    const { reportPdfModel } = await import('../../src/reportPdfLayout.js');
    const model = reportPdfModel({ result }, '', '回归作业');
    const card = model.find((n) => n.continuation === '句群 01');
    expect(card.children.find((n) => n.label === '完整纠错版').runs[0].text).toBe(correction);
    const summary = model.find((n) => n.continuation === '综合评价');
    expect(summary.children.some((n) => n.runs?.some((r) => r.text === result.overall.taskAssessment.message))).toBe(true);
  });
  it('语义复核失败时显示实际状态，不把首次批改伪装成已复核', () => {
    render(<ResultSheet result={{ ...data(), translationReview: { status: 'unavailable' } }} history={[]} />);
    expect(screen.getByText(/本次语义复核未完成/)).toBeTruthy();
  });
  it('漏译补充显示插入说明，不提示删除邻近译文；教师导出保留同样语义', async () => {
    const anchor = '前一句已经译出。';
    const finding = { category: '漏译', level: 'error', operation: 'insert', from: anchor, to: '补充缺失的事实。', explanation: '原文此句未译出。' };
    const result = { ...data(), sentences: [{ cn: 'Missing fact.', draft: anchor, findings: [finding] }] };
    const view = render(<ResultSheet result={result} history={[]} />);
    expect(screen.getByText(/补充遗漏信息（附近译稿/)).toBeTruthy();
    expect(view.container.querySelector('.finding-diff .from')).toBeNull();
    const { reportBlocks } = await import('../../src/homeworkExport.js');
    expect(reportBlocks({ result }).some((block) => block.text?.includes('补充遗漏信息'))).toBe(true);
  });
  it('中文词条不请求或显示英文音标，切换英文词条仍可查询', async () => {
    const lookup = vi.spyOn(api, 'getPhonetic').mockResolvedValue({ phonetic: '/ˈlaɪbrəri/' });
    const view = render(<Phonetic word="图书馆" phonetic="错误音标" />);
    expect(lookup).not.toHaveBeenCalled(); expect(view.container.textContent).toBe('');
    view.rerender(<Phonetic word="library" />);
    expect(await screen.findByText('/ˈlaɪbrəri/')).toBeTruthy();
    expect(lookup).toHaveBeenCalledWith('library');
  });
  it('只有表达建议的结果明确显示零错漏，流式评分暂不展示', () => {
    const result = { ...data(), draft: '不到五分之一的居民使用它。', sentences: [{ findings: Array.from({ length: 6 }, () => ({ level: 'improve', from: '使用', to: '利用', category: '表达' })) }] };
    render(<ResultSheet result={result} history={[]} streaming={{ active: true }} />);
    expect(screen.getByText('0 处错漏 · 6 条表达建议')).toBeTruthy();
    expect(screen.getByText('评分核对中')).toBeTruthy();
    expect(screen.queryByText('100')).toBeNull();
  });
  it('中文朗读选择中文语音，英文仍使用英语，表达卡只朗读译法', () => {
    const speak = vi.fn();
    const voices = [{ lang: 'en-US' }, { lang: 'zh-CN' }];
    vi.stubGlobal('speechSynthesis', { cancel: vi.fn(), getVoices: () => voices, speak });
    vi.stubGlobal('SpeechSynthesisUtterance', class { constructor(text) { this.text = text; } });
    render(<><SpeakButton text="不到五分之一" label="中文" /><SpeakButton text="library" label="英文" /><SummaryBlock title="高级句式" items={['Fewer than one in five → 不到五分之一 · 中文点拨：数量']} result={{ direction: 'en2cn' }} /></>);
    fireEvent.click(screen.getByLabelText('朗读 中文'));
    expect(speak.mock.calls[0][0].lang).toBe('zh-CN'); expect(speak.mock.calls[0][0].voice.lang).toBe('zh-CN');
    fireEvent.click(screen.getByLabelText('朗读 英文')); expect(speak.mock.calls[1][0].lang).toBe('en-US');
    fireEvent.click(screen.getByLabelText('朗读 不到五分之一')); expect(speak.mock.calls[2][0].text).toBe('不到五分之一');
  });
});
