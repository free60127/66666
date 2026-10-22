import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import WritingStudio from '../../src/components/WritingStudio/index.jsx';
import { WRITING_STORE_KEY, countWritingWords, exportWritingDrafts, loadWritingState, writingTopicKey } from '../../src/writing.js';
import { WRITING_EXAM_BANK } from '../../src/writingExamBank.js';
import { sameLesson } from '../../src/progress.js';
import { switchDataOwner } from '../../src/accountCache.js';

vi.mock('../../src/api.js', () => ({ writingBrief: vi.fn(), getWritingBriefJob: vi.fn() }));
vi.mock('../../src/constants.js', () => ({ POLL_ANALYZE_MS: 1, POLL_MAX_FAILURES: 2, TIMEOUT_ANALYZE_MS: 1000 }));
import { writingBrief } from '../../src/api.js';

const topic = { id: 'custom', zh: 'Practice', question: 'Should students learn to cook?', excerpt: 'Cooking teaches independence and healthy habits.', words: 120 };
const essay = 'Students should learn to cook because this skill helps them live independently. Cooking at home is also a useful way to stay healthy and save money.';
let props;
beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  vi.clearAllMocks();
  vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value() { this.setAttribute('open', ''); } });
  Object.defineProperty(HTMLDialogElement.prototype, 'close', { configurable: true, value() { this.removeAttribute('open'); } });
  props = { busy: false, polishLevel: '四六级', settings: {}, aliveRef: { current: true },
    timer: { running: false, accumulated: 0 }, hasElapsed: false, toggleTimer: vi.fn(), onSubmit: vi.fn() };
});
afterEach(cleanup);
const seed = (extra = {}) => localStorage.setItem(WRITING_STORE_KEY, JSON.stringify({ topic, essay, ...extra }));
const choose = (item) => fireEvent.click(within(screen.getByRole('heading', { name: item.zh }).closest('article')).getByRole('button', { name: '写这篇' }));

describe('writing workspace', () => {
  it('does not cancel pending grading when restoring the same class task after a refresh', () => {
    const assigned = { classId: 'class-a', hwId: 'hw-a', title: 'Task A', question: 'Discuss learning.', material: 'Material A', words: 300 };
    seed({ topic: { ...assigned, id: 'assigned', zh: assigned.title } });
    const onLeaveTopic = vi.fn();
    const { rerender } = render(<WritingStudio {...props} onLeaveTopic={onLeaveTopic} assignedTopic={assigned} />);
    expect(onLeaveTopic).not.toHaveBeenCalled();
    rerender(<WritingStudio {...props} onLeaveTopic={onLeaveTopic} assignedTopic={{ ...assigned, hwId: 'hw-b' }} />);
    expect(onLeaveTopic).toHaveBeenCalledOnce();
  });

  it('switches class assignments, preserving their separate drafts even when the questions match', () => {
    const first = { classId: 'class-a', hwId: 'hw-a', title: 'Task A', question: 'Discuss learning.', material: 'Material A', words: 300 };
    const second = { ...first, hwId: 'hw-b', title: 'Task B', material: 'Material B', words: 150 };
    const { rerender, unmount } = render(<WritingStudio {...props} assignedTopic={first} />);
    fireEvent.change(screen.getByRole('textbox', { name: '我的作文' }), { target: { value: essay } });
    rerender(<WritingStudio {...props} assignedTopic={second} />);
    expect(screen.getByText('Material B')).toBeTruthy();
    expect(screen.queryByText('Material A')).toBeNull();
    expect(screen.getByRole('textbox', { name: '我的作文' }).value).toBe('');
    fireEvent.change(screen.getByRole('textbox', { name: '我的作文' }), { target: { value: essay + ' Task B.' } });
    fireEvent.click(screen.getByRole('button', { name: '提交批改' }));
    expect(props.onSubmit).toHaveBeenCalledWith(expect.objectContaining({ material: 'Material B', targetWords: 150, assignment: { classId: 'class-a', hwId: 'hw-b' } }));
    unmount();
    render(<WritingStudio {...props} assignedTopic={first} />);
    expect(screen.getByRole('textbox', { name: '我的作文' }).value).toBe(essay);
  });

  it('removes the topic lock when the assignment is cleared', () => {
    const { rerender } = render(<WritingStudio {...props} assignedTopic={{ classId: 'c', hwId: 'h', question: 'Question' }} />);
    expect(screen.queryByRole('button', { name: '返回题库' })).toBeNull();
    rerender(<WritingStudio {...props} assignedTopic={null} />);
    expect(screen.getByRole('button', { name: '返回题库' })).toBeTruthy();
  });

  it('saves the parent title and exports the latest edit even if browser storage is full', () => {
    seed();
    const { rerender } = render(<WritingStudio {...props} workTitle="First title" titleTopicKey={writingTopicKey(topic)} />);
    rerender(<WritingStudio {...props} workTitle="Edited title" titleTopicKey={writingTopicKey(topic)} />);
    fireEvent(window, new Event('pagehide'));
    expect(loadWritingState().workTitle).toBe('Edited title');
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('quota'); });
    fireEvent.change(screen.getByRole('textbox', { name: '我的作文' }), { target: { value: essay + ' Unsaved text.' } });
    expect(exportWritingDrafts().some((row) => row.essay.endsWith('Unsaved text.') && row.workTitle === 'Edited title')).toBe(true);
  });

  it('opens the image from the bank without selecting the topic', () => {
    render(<WritingStudio {...props} />);
    fireEvent.click(screen.getByRole('button', { name: '查看大图：儿童户外活动：家长怎么看' }));
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(screen.queryByRole('textbox', { name: '我的作文' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '关闭配图预览' }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('refreshes saved topic metadata to the full chart while preserving the essay and handles preview cancellation', () => {
    const exam = WRITING_EXAM_BANK.find((item) => item.id === 'kaoyan2-2026');
    seed({ topic: { ...exam, image: '/writing/figs/kaoyan2-2026.png' } });
    render(<WritingStudio {...props} />);
    fireEvent.click(screen.getByRole('button', { name: '查看大图：儿童户外活动：家长怎么看' }));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByRole('img').getAttribute('src')).toBe('/writing/figs/kaoyan2-2026-full.png');
    fireEvent(dialog, new Event('cancel', { cancelable: true, bubbles: true }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByRole('textbox', { name: '我的作文' }).value).toBe(essay);
  });

  it('restores the existing draft and flushes the last keystroke on unmount', () => {
    seed();
    const { unmount } = render(<WritingStudio {...props} />);
    expect(screen.getByRole('textbox', { name: '我的作文' }).value).toBe(essay);
    fireEvent.change(screen.getByRole('textbox', { name: '我的作文' }), { target: { value: essay + ' Last edit.' } });
    expect(props.toggleTimer).toHaveBeenCalledOnce();
    unmount();
    expect(loadWritingState().essay).toBe(essay + ' Last edit.');
  });

  it('keeps each topic draft separate and restores it on returning to that topic', () => {
    const [first, second] = WRITING_EXAM_BANK;
    seed({ topic: first });
    render(<WritingStudio {...props} />);
    fireEvent.click(screen.getByRole('button', { name: '返回题库' }));
    choose(second);
    expect(screen.getByRole('textbox', { name: '我的作文' }).value).toBe('');
    fireEvent.change(screen.getByRole('textbox', { name: '我的作文' }), { target: { value: 'Another essay.' } });
    fireEvent.click(screen.getByRole('button', { name: '返回题库' }));
    choose(first);
    expect(screen.getByRole('textbox', { name: '我的作文' }).value).toBe(essay);
    fireEvent.click(screen.getByRole('button', { name: '返回题库' }));
    choose(second);
    expect(screen.getByRole('textbox', { name: '我的作文' }).value).toBe('Another essay.');
  });

  it('preserves all paragraphs when moving between direct and guided writing', () => {
    const text = 'Introduction.\n\nBody one.\n\nBody two.\n\nConclusion.\n\nExtra paragraph.';
    seed({ essay: text });
    render(<WritingStudio {...props} />);
    fireEvent.click(screen.getByRole('tab', { name: /按段带写/ }));
    expect(screen.getByRole('textbox', { name: '引言' }).value).toBe('Introduction.');
    fireEvent.change(screen.getByRole('textbox', { name: '引言' }), { target: { value: 'Edited introduction.' } });
    fireEvent.click(screen.getByRole('tab', { name: /直接开写/ }));
    expect(screen.getByRole('textbox', { name: '我的作文' }).value).toBe(text.replace('Introduction.', 'Edited introduction.'));
  });

  it('displays the result returned by the guidance job and submits the reading material', async () => {
    seed();
    writingBrief.mockResolvedValue({ data: { stance: 'Discuss the practical benefits.', outline: ['引言：给出观点'], patterns: ['Learning to cook helps us…'] } });
    render(<WritingStudio {...props} />);
    expect(screen.getByText(topic.excerpt)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /^AI 写作引导/ }));
    fireEvent.click(screen.getByRole('button', { name: '生成本题写作指导' }));
    expect(await screen.findByText('Discuss the practical benefits.')).toBeTruthy();
    expect(writingBrief).toHaveBeenCalledWith(expect.objectContaining({ material: topic.excerpt }));
    fireEvent.click(screen.getByRole('button', { name: '提交批改' }));
    expect(props.onSubmit).toHaveBeenCalledWith(expect.objectContaining({ material: topic.excerpt, essay, topicId: writingTopicKey(topic), targetWords: 120 }));
  });

  it('ignores guidance for a topic the user has already left', async () => {
    seed();
    let resolve;
    writingBrief.mockImplementation(() => new Promise((r) => { resolve = r; }));
    render(<WritingStudio {...props} />);
    fireEvent.click(screen.getByRole('button', { name: /^AI 写作引导/ }));
    fireEvent.click(screen.getByRole('button', { name: '生成本题写作指导' }));
    fireEvent.click(screen.getByRole('button', { name: '返回题库' }));
    choose(WRITING_EXAM_BANK[0]);
    await act(async () => resolve({ data: { stance: 'Outdated topic guidance' } }));
    expect(screen.queryByText('Outdated topic guidance')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /^AI 写作引导/ }));
    expect(screen.getByRole('button', { name: '生成本题写作指导' })).toBeTruthy();
  });

  it('guides the active paragraph above the editor, regenerates for a selected angle, and keeps the essay', async () => {
    seed();
    const data = {
      stance: '讨论做饭的价值与条件。', selectedAngle: '培养独立能力', angles: ['培养独立能力', '以兴趣为前提'],
      paragraphs: ['intro', 'body1', 'body2', 'concl'].map((key, index) => ({ key, goal: '段落目标 ' + index,
        steps: [{ idea: '段落思路 ' + index, keywords: ['healthy habits'], pattern: 'Learning to cook develops 【能力】.' },
          { idea: '补充例证 ' + index, keywords: [], pattern: 'For example, 【具体例子】.' }],
      })),
    };
    writingBrief.mockResolvedValueOnce({ data }).mockResolvedValueOnce({ data: { ...data, selectedAngle: '以兴趣为前提' } });
    const { container, unmount } = render(<WritingStudio {...props} />);
    fireEvent.click(screen.getByRole('tab', { name: /按段带写/ }));
    expect(container.querySelector('.ws-side .ws-brief')).toBeNull();
    expect(container.querySelector('.ws-editor .ws-brief').compareDocumentPosition(container.querySelector('.ws-essay')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '生成本题写作指导' }));
    expect(await screen.findByText('段落思路 0')).toBeTruthy();
    const patterns = container.querySelectorAll('.ws-guide-pattern');
    expect(patterns.length).toBe(2);
    expect(patterns[0].open).toBe(false);
    fireEvent.click(patterns[0].querySelector('summary'));
    expect(patterns[0].open).toBe(true);
    expect(patterns[1].open).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: /主体段 1/ }));
    expect(screen.getByText('段落思路 1')).toBeTruthy();
    expect(screen.queryByText('段落思路 0')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '切换立场 / 角度' }));
    fireEvent.click(screen.getByRole('button', { name: '以兴趣为前提', exact: true }));
    await waitFor(() => expect(writingBrief).toHaveBeenCalledTimes(2));
    expect(writingBrief.mock.calls[1][0]).toEqual(expect.objectContaining({ angle: '以兴趣为前提', targetWords: 120 }));
    await waitFor(() => expect(screen.getByRole('button', { name: '换一版指导' }).disabled).toBe(false));
    fireEvent.click(screen.getByRole('tab', { name: /直接开写/ }));
    expect(screen.getByRole('textbox', { name: '我的作文' }).value).toBe(essay);
    unmount();
    expect(loadWritingState().brief.selectedAngle).toBe('以兴趣为前提');
    render(<WritingStudio {...props} />);
    expect(screen.getByText('以兴趣为前提')).toBeTruthy();
    expect(writingBrief).toHaveBeenCalledTimes(2);
  });

  it('accepts a custom angle and retains the previous guide when regeneration fails', async () => {
    seed();
    writingBrief.mockResolvedValueOnce({ data: { stance: 'Saved guidance', outline: ['First paragraph'] } }).mockRejectedValueOnce(new Error('Temporary failure'));
    render(<WritingStudio {...props} />);
    fireEvent.click(screen.getByRole('button', { name: /^AI 写作引导/ }));
    fireEvent.change(screen.getByLabelText('我的立场或分析角度（可选）'), { target: { value: '以学生需求为出发点' } });
    fireEvent.click(screen.getByRole('button', { name: '生成本题写作指导' }));
    expect(await screen.findByText('Saved guidance')).toBeTruthy();
    expect(writingBrief).toHaveBeenCalledWith(expect.objectContaining({ angle: '以学生需求为出发点' }));
    fireEvent.click(screen.getByRole('button', { name: '换一版指导' }));
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'Temporary failure');
    expect(screen.getByText('Saved guidance')).toBeTruthy();
    expect(screen.getByRole('textbox', { name: '我的作文' }).value).toBe(essay);
  });

  it('imports recognized English into the essay and provides a separate camera capture input', async () => {
    seed();
    props.onOcrImages = vi.fn().mockResolvedValue('Recognized handwritten text.');
    const { container } = render(<WritingStudio {...props} />);
    const input = container.querySelector('input[type="file"][capture="environment"]');
    expect(input).toBeTruthy();
    fireEvent.change(input, { target: { files: [new File(['image'], 'essay.png', { type: 'image/png' })] } });
    await waitFor(() => expect(screen.getByRole('textbox', { name: '我的作文' }).value).toBe(essay + '\n\nRecognized handwritten text.'));
    expect(props.onOcrImages).toHaveBeenCalledOnce();
  });

  it('flushes on pagehide and reports storage failure instead of claiming the draft is saved', async () => {
    seed();
    render(<WritingStudio {...props} />);
    fireEvent.change(screen.getByRole('textbox', { name: '我的作文' }), { target: { value: essay + ' Page hide edit.' } });
    fireEvent(window, new Event('pagehide'));
    expect(loadWritingState().essay).toContain('Page hide edit.');
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('quota'); });
    fireEvent.change(screen.getByRole('textbox', { name: '我的作文' }), { target: { value: essay + ' Unsaved quota edit.' } });
    fireEvent.click(screen.getByRole('button', { name: '提交批改' }));
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', expect.stringContaining('草稿未能保存'));
  });

  it('uses stable, separate identities for custom topics and compares only the same writing topic', () => {
    const a = writingTopicKey(topic);
    const b = writingTopicKey({ ...topic, question: 'Should students learn music?' });
    expect(a).not.toBe(b);
    expect(a).toBe(writingTopicKey({ ...topic, zh: 'New title' }));
    expect(sameLesson({ direction: 'writing', lessonKey: a }, { direction: 'writing', lessonKey: a })).toBe(true);
    expect(sameLesson({ direction: 'writing', lessonKey: a }, { direction: 'writing', lessonKey: b })).toBe(false);
    expect(countWritingWords('中文提示 — don’t re-read 120 words.')).toBe(4);
    localStorage.setItem(WRITING_STORE_KEY, '{broken');
    expect(loadWritingState()).toBeNull();
  });

  it('flushes before an account switch without writing the previous user draft into the next account', () => {
    switchDataOwner('alice'); seed();
    const { unmount } = render(<WritingStudio {...props} />);
    fireEvent.change(screen.getByRole('textbox', { name: '我的作文' }), { target: { value: essay + ' Private edit.' } });
    switchDataOwner('bob');
    unmount();
    expect(loadWritingState()).toBeNull();
    switchDataOwner('alice');
    expect(loadWritingState().essay).toBe(essay + ' Private edit.');
  });
});
