import React from 'react';
import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import { cleanup, render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { FavReviewPanel } from '../../src/components/ResultSheet/Review.jsx';
import { QuizSheet } from '../../src/components/ResultSheet/Quiz.jsx';
import WritingStudio from '../../src/components/WritingStudio/index.jsx';
import LearningHome from '../../src/components/LearningHome.jsx';
import { favFromFinding } from '../../src/favorites.js';
import { loadQuizSession, newQuizSession, saveQuizSession, QUIZ_SESSION_PREFIX } from '../../src/quizSession.js';
import { switchDataOwner } from '../../src/accountCache.js';
import { revisionTopic, normalizeWritingDraft, writingTopicKey, writingTargetWords } from '../../src/writing.js';
import { compareWithPrevious, sameLesson } from '../../src/progress.js';
import { writingSteps, writingTaskType, questionWordTarget, writingContext } from '../../src/writingTask.js';
import { learningRecommendations, nextWritingTopic } from '../../src/learningHome.js';
import { buildWritingBriefMessage } from '../../server/prompt.mjs';
import { WRITING_EXAM_BANK } from '../../src/writingExamBank.js';
import { quiz as quizApi, writingBrief } from '../../src/api.js';

vi.mock('../../src/api.js', () => ({ quiz: vi.fn(), getQuizJob: vi.fn(), writingBrief: vi.fn(), getWritingBriefJob: vi.fn() }));
const blank = { type: '填空', question: 'I ___ a student.', answer: 'am' };
const makeQuiz = (questions = [blank]) => newQuizSession({ title: 'Practice quiz', questions });
const quizProps = (quiz, extra = {}) => ({ quiz, settings: {}, showAnswers: false, onBack: vi.fn(), onCopy: vi.fn(), ...extra });
beforeEach(() => { localStorage.clear(); sessionStorage.clear(); vi.resetAllMocks(); vi.spyOn(window, 'scrollTo').mockImplementation(() => {}); });
afterEach(cleanup);

describe('recall comes before the answer', () => {
  it.each(['new', 'legacy'])('hides the corrected expression for a %s finding until revealed', (version) => {
    const item = favFromFinding({ from: 'He go to school.', to: 'He goes to school.', explanation: '主谓一致' }, { title: 'Work' });
    if (version === 'legacy') { delete item.recallPrompt; delete item.recallAnswer; }
    const props = { session: { ids: [item.id], index: 0, tally: {} }, items: [item], onReveal: vi.fn() };
    const { rerender } = render(<FavReviewPanel {...props} />);
    expect(screen.getByText('He go to school.')).toBeTruthy();
    expect(screen.queryByText('He goes to school.', { exact: false })).toBeNull();
    rerender(<FavReviewPanel {...props} session={{ ...props.session, revealed: true }} />);
    expect(screen.getByText('He goes to school.', { exact: false })).toBeTruthy();
  });
});

describe('local quiz recovery', () => {
  it('flushes before opening the learning home and an idle tab cannot erase newer answers', () => {
    const quiz = makeQuiz(); const props = quizProps(quiz);
    const { unmount } = render(<QuizSheet {...props} />);
    fireEvent.change(screen.getByPlaceholderText('填入空格处的内容…'), { target: { value: 'am' } });
    act(() => window.dispatchEvent(new Event('bts:flush-quiz')));
    expect(loadQuizSession().answers[0]).toBe('am');
    saveQuizSession(quiz, { 0: 'other tab answer' });
    unmount();
    expect(loadQuizSession().answers[0]).toBe('other tab answer');
  });
  it('merges concurrent edits to different questions and refuses conflicting edits to the same question', () => {
    const quiz = makeQuiz([blank, { ...blank, question: 'Another blank' }]);
    const baseline = loadQuizSession();
    saveQuizSession(quiz, { 0: 'first tab' });
    expect(saveQuizSession(quiz, { 1: 'second tab' }, {}, '', false, baseline)).toBe(true);
    expect(loadQuizSession().answers).toEqual({ 0: 'first tab', 1: 'second tab' });
    expect(saveQuizSession(quiz, { 0: 'conflict' }, {}, '', false, baseline)).toBe(false);
    expect(loadQuizSession().answers[0]).toBe('first tab');
  });
  it('flushes the last answer on navigation and restores answers and verdicts without an AI call', () => {
    const quiz = makeQuiz(); const props = quizProps(quiz);
    const { unmount } = render(<QuizSheet {...props} />);
    fireEvent.change(screen.getByPlaceholderText('填入空格处的内容…'), { target: { value: 'am' } });
    fireEvent.click(screen.getByRole('button', { name: '核对', exact: true }));
    unmount();
    render(<QuizSheet {...props} />);
    expect(screen.getByPlaceholderText('填入空格处的内容…').value).toBe('am');
    expect(document.querySelector('.quiz-verdict.right')).toBeTruthy();
    expect(quizApi).not.toHaveBeenCalled();
  });
  it('switching to a fresh quiz with identical questions does not carry old answers or steal the current pointer', () => {
    const first = makeQuiz();
    const { rerender } = render(<QuizSheet {...quizProps(first)} />);
    fireEvent.change(screen.getByPlaceholderText('填入空格处的内容…'), { target: { value: 'old answer' } });
    const second = makeQuiz();
    rerender(<QuizSheet {...quizProps(second)} />);
    expect(screen.getByPlaceholderText('填入空格处的内容…').value).toBe('');
    expect(loadQuizSession().quiz._sessionId).toBe(second._sessionId);
    expect(loadQuizSession(first._sessionId).answers[0]).toBe('old answer');
  });
  it('keeps only three quizzes and isolates them across account changes', () => {
    switchDataOwner('alice');
    let quiz;
    for (let i = 0; i < 5; i++) quiz = makeQuiz();
    saveQuizSession(quiz, { 0: 'alice answer' });
    expect(Object.keys(localStorage).filter((key) => key.startsWith(QUIZ_SESSION_PREFIX))).toHaveLength(3);
    switchDataOwner('bob'); expect(loadQuizSession()).toBeNull();
    switchDataOwner('alice'); expect(loadQuizSession().answers[0]).toBe('alice answer');
  });
  it('publishes only a completed score and does not resubmit that summary on refresh', async () => {
    const quiz = makeQuiz([blank, { ...blank, question: 'Another blank' }]); const onComplete = vi.fn();
    const props = quizProps(quiz, { onComplete });
    const { unmount } = render(<QuizSheet {...props} />);
    const inputs = screen.getAllByPlaceholderText('填入空格处的内容…');
    fireEvent.change(inputs[0], { target: { value: 'am' } });
    fireEvent.click(screen.getAllByRole('button', { name: '核对', exact: true })[0]);
    expect(onComplete).not.toHaveBeenCalled();
    fireEvent.change(inputs[1], { target: { value: 'wrong' } });
    fireEvent.click(screen.getAllByRole('button', { name: '核对', exact: true })[1]);
    await waitFor(() => expect(onComplete).toHaveBeenCalledWith(quiz._sessionId, 50));
    unmount(); render(<QuizSheet {...props} />);
    expect(onComplete).toHaveBeenCalledTimes(1);
  });
  it('ignores AI grading for an answer changed while the request was running', async () => {
    let resolve;
    quizApi.mockImplementation(() => new Promise((r) => { resolve = r; }));
    render(<QuizSheet {...quizProps(makeQuiz([{ type: '翻译', question: '今天我和朋友去学校。', answer: 'I went to school with my friends today.' }]))} />);
    const input = screen.getByPlaceholderText('用英文写下你的答案…');
    fireEvent.change(input, { target: { value: 'Hello' } });
    fireEvent.click(screen.getByRole('button', { name: '批改', exact: true }));
    fireEvent.change(input, { target: { value: 'New answer' } });
    await act(async () => resolve({ data: { grades: [{ index: 0, verdict: 'right', comment: 'OLD VERDICT' }] } }));
    expect(screen.queryByText('OLD VERDICT')).toBeNull();
    expect(input.value).toBe('New answer');
  });
  it('reports storage failure without discarding the visible answer', async () => {
    const quiz = makeQuiz(); render(<QuizSheet {...quizProps(quiz)} />);
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('full'); });
    fireEvent.change(screen.getByPlaceholderText('填入空格处的内容…'), { target: { value: 'my answer' } });
    expect(await screen.findByText(/答题进度未能保存到本机/)).toBeTruthy();
    expect(screen.getByPlaceholderText('填入空格处的内容…').value).toBe('my answer');
  });
});

describe('revision identity and comparison', () => {
  const base = { direction: 'writing', chinese: 'Discuss learning.', draft: 'First essay.', lessonKey: 'writing:assigned:class-a:hw-a',
    writingTopic: { id: 'assigned', classId: 'class-a', hwId: 'hw-a', question: 'Discuss learning.' },
    overall: { score: 60 }, sentences: [{ findings: [{ category: '语法', level: 'error' }] }] };
  it('keeps draft identity separate while retaining parent and root across repeated revisions', () => {
    const topic = revisionTopic(base, 'original-job');
    const restored = normalizeWritingDraft({ topic, essay: 'Revision essay.' });
    expect(restored.topic.parentJobId).toBe('original-job');
    expect(restored.topic.classId).toBeUndefined();
    expect(writingTopicKey(topic)).not.toBe(base.lessonKey);
    const revised = { ...base, lessonKey: writingTopicKey(topic), writingTopic: restored.topic };
    expect(sameLesson(base, revised)).toBe(true);
    expect(revisionTopic(revised, 'revision-job')).toMatchObject({ parentJobId: 'revision-job', rootJobId: 'original-job', sourceTopicKey: base.lessonKey });
    expect(sameLesson(base, { ...base, lessonKey: 'writing:assigned:class-a:hw-b' })).toBe(false);
  });
  it('compares the explicit parent rather than an unrelated newer attempt and identifies new categories', () => {
    const topic = revisionTopic(base, 'original-job');
    const result = { ...base, writingTopic: topic, lessonKey: writingTopicKey(topic), overall: { score: 80 }, sentences: [{ findings: [{ category: '拼写', level: 'error' }] }] };
    const cmp = compareWithPrevious({ result, jobId: 'current', history: [{ jobId: 'other', time: 200 }, { jobId: 'original-job', time: 100 }],
      readResult: (id) => id === 'original-job' ? base : { ...base, overall: { score: 99 } } });
    expect(cmp.prev.jobId).toBe('original-job'); expect(cmp.score.delta).toBe(20);
    expect(cmp.newCategories[0].cat).toBe('拼写');
  });
  it('keeps cloud history metadata compact even for a very long reading passage', () => {
    expect(JSON.stringify(writingContext({ ...base.writingTopic, material: 'x'.repeat(40000), question: 'x'.repeat(40000), parentJobId: 'job' })).length).toBeLessThan(1000);
    expect(writingContext({ image: 'data:image/png;base64,' + 'x'.repeat(40000) }).image).toBeUndefined();
    const chart = writingContext({ image: '/writing/figs/kaoyan2-2026-full.png' });
    expect(revisionTopic({ ...base, writingTopic: chart }, 'chart-job').image).toBe(chart.image);
  });
});

describe('task-specific writing without extra AI requests', () => {
  it('routes letters, objective charts and material tasks and recognizes the requested word count', () => {
    expect(writingTaskType({ question: 'Write an email in about 100 words.' })).toBe('letter');
    expect(writingTargetWords({ question: 'Write an email in about 100 words.' }, '四六级')).toBe(100);
    expect(questionWordTarget('Write 150–200 words.')).toBe(175);
    expect(writingSteps({ question: 'Summarise the chart.' })[3].label).toBe('补充对比');
    expect(writingSteps({ question: 'Interpret the chart and give your comments.' })[3].label).toBe('解读与评论');
    expect(writingSteps({ material: 'Excerpt 1 ... Excerpt 2 ...' })[0].label).toBe('概括材料');
    const message = buildWritingBriefMessage({ topic: 'Write an email.', level: '四六级', targetWords: 100 });
    expect(message).toContain('称呼与来意'); expect(message).toContain('结束语与落款');
  });
  it('opens a custom 100-word letter with matching steps and keeps text when the learner changes the task type', () => {
    render(<WritingStudio busy={false} polishLevel="四六级" settings={{}} aliveRef={{ current: true }} timer={{ running: false }} toggleTimer={vi.fn()} onSubmit={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /自定义题目：/ }));
    fireEvent.change(screen.getByLabelText('自定义作文题目'), { target: { value: 'Write an email inviting a friend in about 100 words.' } });
    fireEvent.click(screen.getByRole('button', { name: '用这道题写作' }));
    expect(screen.getByText(/练习目标：约 100 词/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText('我的作文'), { target: { value: 'Dear John,\n\nPlease join us.' } });
    fireEvent.click(screen.getByRole('tab', { name: /按段带写/ }));
    expect(screen.getByLabelText('称呼与来意').value).toBe('Dear John,');
    fireEvent.change(screen.getByLabelText('写作题型'), { target: { value: 'essay' } });
    expect(screen.getByLabelText('引言').value).toBe('Dear John,');
    expect(writingBrief).not.toHaveBeenCalled();
  });
});

describe('learning home rules', () => {
  it('recommends unfinished work, quiz and due cards but excludes unchanged submitted drafts', () => {
    const topic = { id: 'custom', question: 'Learning?' };
    const draft = { topic, essay: 'Already submitted', mode: 'direct' };
    const cards = learningRecommendations({ drafts: [draft], history: [{ jobId: 'done', lessonKey: writingTopicKey(topic), time: 1 }],
      readResult: () => ({ draft: 'Already submitted' }), favorites: [{ id: 'fav', title: 'word', due: 1 }], quizSession: { quiz: { questions: [blank] }, verdicts: {} } });
    expect(cards.map((card) => card.kind)).toEqual(['quiz', 'review']);
    expect(learningRecommendations({ drafts: [{ ...draft, essay: 'Changed essay' }] })[0].kind).toBe('writing-draft');
  });
  it('selects an unpractised writing topic in the learner level and lets the user change focus', () => {
    const first = nextWritingTopic(WRITING_EXAM_BANK, {}, '专八');
    expect(first.exam).toBe('tem8');
    expect(nextWritingTopic(WRITING_EXAM_BANK, { [writingTopicKey(first)]: { n: 1 } }, '专八').id).not.toBe(first.id);
    const onWriting = vi.fn();
    render(<LearningHome history={[]} favorites={[]} progress={{}} level="专八" onWriting={onWriting} />);
    fireEvent.change(screen.getByLabelText('学习重点'), { target: { value: 'writing' } });
    expect(screen.queryByRole('button', { name: '进入翻译练习' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '开始这篇写作' })); expect(onWriting).toHaveBeenCalledWith(first);
  });
});
