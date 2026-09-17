/**
 * 自测卷的交互与批改（QuizSheet + useQuizGrade）。
 *
 * 为什么值得测：这一层是"能不能真的做题"的关键 —— 选择题点不动、填空核对按钮没反应、
 * 批改之后判定贴到别的题上，任何一个都会让整份卷子白做。而 AI 那一段还牵着一条
 * "提交→轮询→落到题上"的异步链路，以及 AI 用不了时的自评兜底（不能把学生卡在转圈上）。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { QuizSheet } from '../../src/components/ResultSheet/Quiz.jsx';
import { quiz as quizApi, getQuizJob } from '../../src/api.js';

vi.mock('../../src/api.js', () => ({ quiz: vi.fn(), getQuizJob: vi.fn() }));

const CHOICE = {
  type: '选择',
  question: '当那人试图让快艇转弯时，方向盘脱手了。\nWhen the man tried to ___ the speedboat round, the steering wheel slipped from his grasp.',
  options: ['A. swerve', 'B. swing', 'C. sway', 'D. sweep'],
  answer: 'B',
  explanation: 'swing round 是"（车船）转弯"的固定说法',
};

const BLANK = { type: '填空', question: 'I have just received a letter from my ___, informing me that...', options: [], answer: 'old school', explanation: '母校 = old school' };

const FIX = {
  type: '改错',
  question: '改正下面句子中的错误：When the man tried to swing the speedboat round, the controller slipped from his hands.',
  options: [],
  answer: 'When the man tried to swing the speedboat round, the steering wheel slipped from his grasp.',
  explanation: '快艇上的是舵轮 steering wheel',
};

const WRITE = { type: '翻译', question: '把这句话译成英文：「他绝望地向他的伙伴挥手。」', options: [], answer: 'He waved desperately to his companion.', explanation: '绝望地 = desperately' };

const quiz = (questions) => ({ title: '收藏知识点自测（' + questions.length + ' 题）', level: '四六级', count: questions.length, questions });

function setup(questions, over = {}) {
  const props = {
    quiz: quiz(questions), settings: { baseUrl: 'http://x/v1', model: 'm', apiKey: 'k' },
    showAnswers: false, onToggleAnswers: vi.fn(), onBack: vi.fn(), onBackToFav: vi.fn(), onCopy: vi.fn(), tip: '',
    ...over,
  };
  render(<QuizSheet {...props} />);
  return props;
}

const stat = () => document.querySelector('.quiz-grade-stat').textContent;
/** 第 i 个选项按钮（DOM 里的可访问名是「B swing」，带不带点都不稳，直接按位置取） */
const optBtn = (i) => document.querySelectorAll('.quiz-opt')[i];

beforeEach(() => { vi.clearAllMocks(); });
afterEach(() => cleanup());

describe('选择题：点选项立刻判对错', () => {
  it('点对的那个 → 对，并标出标准答案', () => {
    setup([CHOICE]);
    fireEvent.click(optBtn(1));
    expect(document.querySelector('.quiz-verdict.right')).toBeTruthy();
    expect(document.querySelector('.quiz-verdict-tag').textContent).toBe('对');
    // 选中的那个本身就是对的 → 它是绿色，不必再叠一层「标准答案」标记
    expect(document.querySelector('.quiz-opt.right .quiz-opt-key').textContent).toBe('B');
    expect(stat()).toContain('对 1');
  });

  it('点错的那个 → 错，同时把正确答案那一项标出来', () => {
    setup([CHOICE]);
    fireEvent.click(optBtn(0));
    expect(document.querySelector('.quiz-verdict.wrong')).toBeTruthy();
    expect(document.querySelector('.quiz-opt.wrong')).toBeTruthy();
    expect(document.querySelector('.quiz-opt.is-answer').textContent).toContain('swing');
    expect(stat()).toContain('错 1');
  });

  it('判过之后选项锁住（再点也改不了判定），但可以「重做本题」', () => {
    setup([CHOICE]);
    const wrong = optBtn(0);
    fireEvent.click(wrong);
    expect(wrong.disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: '重做本题' }));
    expect(document.querySelector('.quiz-verdict')).toBeNull();
    expect(document.querySelector('.quiz-opt.wrong')).toBeNull();
  });
});

describe('填空 / 改错：写完点「核对」', () => {
  it('填空写对 → 对；没写时核对按钮不可点', () => {
    setup([BLANK]);
    const btn = screen.getByRole('button', { name: '核对' });
    expect(btn.disabled).toBe(true);
    fireEvent.change(screen.getByPlaceholderText('填入空格处的内容…'), { target: { value: 'Old School.' } });
    fireEvent.click(btn);
    expect(document.querySelector('.quiz-verdict.right')).toBeTruthy();
  });

  it('填空写错 → 判定里给出标准答案与解析', () => {
    setup([BLANK]);
    fireEvent.change(screen.getByPlaceholderText('填入空格处的内容…'), { target: { value: 'mother school' } });
    fireEvent.click(screen.getByRole('button', { name: '核对' }));
    const box = document.querySelector('.quiz-verdict.wrong');
    expect(box).toBeTruthy();
    expect(box.textContent).toContain('old school');
    expect(box.textContent).toContain('母校');
  });

  it('改错改对了 → 对；改动一处用词 → 接近（留给 AI 复核，不武断判错）', () => {
    setup([FIX]);
    const box = () => screen.getByPlaceholderText('写出改好的整句…');
    fireEvent.change(box(), { target: { value: FIX.answer } });
    fireEvent.click(screen.getByRole('button', { name: '核对' }));
    expect(document.querySelector('.quiz-verdict.right')).toBeTruthy();
    cleanup();

    setup([FIX]);
    fireEvent.change(screen.getByPlaceholderText('写出改好的整句…'), { target: { value: 'When the man tried to swing the speedboat round, the steering wheel slipped from his hands.' } });
    fireEvent.click(screen.getByRole('button', { name: '核对' }));
    expect(document.querySelector('.quiz-verdict.close')).toBeTruthy();
    expect(document.querySelector('.quiz-mark.close').textContent).toBe('接近');
  });

  it('改作答会把旧判定作废（不会出现"答案改了、判定还是旧的"）', () => {
    setup([BLANK]);
    fireEvent.change(screen.getByPlaceholderText('填入空格处的内容…'), { target: { value: 'old school' } });
    fireEvent.click(screen.getByRole('button', { name: '核对' }));
    expect(document.querySelector('.quiz-verdict')).toBeTruthy();
    fireEvent.change(screen.getByPlaceholderText('填入空格处的内容…'), { target: { value: 'old schools' } });
    expect(document.querySelector('.quiz-verdict')).toBeNull();
    expect(stat()).toContain('共 1 题');
  });
});

describe('主观题：底部「批改」交给 AI', () => {
  it('翻译题由 AI 判，点评与更好的表达都落在这一题上', async () => {
    quizApi.mockResolvedValue({ jobId: 'job-1' });
    getQuizJob.mockResolvedValue({ job: { status: 'done', data: { grades: [{ index: 0, verdict: 'close', comment: 'desperately 是副词，不要写成 desperate', better: 'He waved desperately to his companion.' }] } } });
    setup([WRITE]);
    fireEvent.change(screen.getByPlaceholderText('用英文写下你的答案…'), { target: { value: 'He waved desperate to his companion.' } });
    fireEvent.click(screen.getByRole('button', { name: '批改' }));
    await waitFor(() => expect(document.querySelector('.quiz-verdict.close')).toBeTruthy(), { timeout: 6000 });
    const box = document.querySelector('.quiz-verdict.close');
    expect(box.textContent).toContain('AI 批改');
    expect(box.textContent).toContain('desperately 是副词');
    expect(box.textContent).toContain('He waved desperately to his companion.');
    expect(stat()).toContain('接近 1');
    // 提交时把学生的作答带上了（否则模型没法判）
    const sent = quizApi.mock.calls[0][0];
    expect(sent.mode).toBe('grade');
    expect(sent.items[0].userAnswer).toBe('He waved desperate to his companion.');
    expect(sent.items[0].index).toBe(0);
  });

  it('★ AI 不可用（后端没起/没配 Key）→ 退回自评，不把学生卡在转圈上', async () => {
    quizApi.mockRejectedValue(new Error('网络连接失败：请检查网络是否正常'));
    setup([WRITE]);
    fireEvent.change(screen.getByPlaceholderText('用英文写下你的答案…'), { target: { value: 'He waved desperate.' } });
    fireEvent.click(screen.getByRole('button', { name: '批改' }));
    await waitFor(() => expect(document.querySelector('.quiz-verdict.pending')).toBeTruthy(), { timeout: 6000 });
    expect(document.querySelector('.quiz-grade-tip').textContent).toContain('AI 批改暂时用不了');
    expect(screen.getByText('待自评')).toBeTruthy();
    expect(document.querySelector('.quiz-verdict.pending').textContent).toContain('He waved desperately to his companion.');

    fireEvent.click(screen.getByRole('button', { name: '我写对了' }));
    expect(document.querySelector('.quiz-verdict.right')).toBeTruthy();
    expect(stat()).toContain('对 1');
    expect(stat()).not.toContain('待自评');
  });

  it('本地能判的题不会白送给 AI（省钱、也快）', async () => {
    quizApi.mockRejectedValue(new Error('不该被调用'));
    setup([CHOICE, BLANK]);
    fireEvent.click(optBtn(1));
    fireEvent.change(screen.getByPlaceholderText('填入空格处的内容…'), { target: { value: 'old school' } });
    fireEvent.click(screen.getByRole('button', { name: '批改' }));
    await waitFor(() => expect(stat()).toContain('对 2'));
    expect(quizApi).not.toHaveBeenCalled();
  });
});

describe('底部批改条', () => {
  it('没做题时提示"做完点批改"，做好后给出对/接近/错的汇总', () => {
    setup([CHOICE, BLANK]);
    expect(stat()).toContain('共 2 题');
    fireEvent.click(optBtn(1));
    fireEvent.change(screen.getByPlaceholderText('填入空格处的内容…'), { target: { value: 'mother school' } });
    fireEvent.click(screen.getAllByRole('button', { name: '核对' })[0]);
    expect(stat()).toContain('已批改');
    expect(stat()).toContain('对 1');
    expect(stat()).toContain('错 1');
  });

  it('重做清空所有作答与判定', () => {
    setup([CHOICE]);
    fireEvent.click(optBtn(1));
    fireEvent.click(screen.getByRole('button', { name: '重做' }));
    expect(document.querySelector('.quiz-verdict')).toBeNull();
    expect(stat()).toContain('共 1 题');
  });
});

describe('打印版不受影响', () => {
  it('「显示答案」仍然能放出卷末的答案与解析（导出 PDF 要用）', () => {
    setup([CHOICE]);
    const sec = document.querySelector('.quiz-answers');
    expect(sec.className).toContain('hidden');
    cleanup();
    setup([CHOICE], { showAnswers: true });
    expect(document.querySelector('.quiz-answers').className).not.toContain('hidden');
  });
});
