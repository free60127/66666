import React, { useRef, useState } from 'react';
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useGeneration } from '../../src/hooks/useGeneration.js';
import { useJobRunner } from '../../src/hooks/useJobRunner.js';
import { loadHistory, saveHistory } from '../../src/storage.js';
import { mergeHistory } from '../../src/syncMerge.js';

vi.mock('../../src/api.js', () => ({ analyze: vi.fn(), getAnalyzeJob: vi.fn(), deleteAnalyzeJob: vi.fn() }));
vi.mock('../../src/constants.js', () => ({ POLL_ANALYZE_MS: 1, TIMEOUT_ANALYZE_MS: 2000 }));
vi.mock('../../src/classroom.js', () => ({ activeHomework: vi.fn(() => null), clearActiveHomework: vi.fn(), reportCompletedJob: vi.fn(), retryClassReports: vi.fn() }));
import { analyze, getAnalyzeJob } from '../../src/api.js';
import { activeHomework } from '../../src/classroom.js';
const complete = { title: '模型标题', chinese: '题目', draft: '初稿', ai: '润色', overall: { score: 85 }, sentences: [] };
function useHarness(streamResults = false) {
  const runner = useJobRunner();
  const [view, setView] = useState('editor');
  const [error, setError] = useState('');
  const generation = useGeneration({ title: '我的作业', chinese: '题目', draft: '初稿', manualOriginal: '', generatedOriginal: '',
    mode: 'free', lessonKey: 'free', settings: {}, streamResults, direction: 'cn2en', view,
    polishLevel: '小初', runJob: runner.run, busy: runner.busy, cancelProgress: runner.cancelWait,
    elapsedMsNow: () => 500, genTokenRef: useRef(0), aliveRef: useRef(true), setView, setError,
    setHistoryOpen: vi.fn(), setChinese: vi.fn(), flashTip: vi.fn(), setToast: vi.fn() });
  return { ...generation, view, error, busy: runner.busy };
}
beforeEach(() => { localStorage.clear(); window.history.replaceState(null, '', '/'); vi.clearAllMocks(); activeHomework.mockReturnValue(null); });
describe('generation recovery', () => {
  it('submits writing content without attaching an active translation homework', async () => {
    activeHomework.mockReturnValue({ classId: 'translation-class', hwId: 'translation-task', prompt: '班级翻译题' });
    analyze.mockResolvedValue({ jobId: 'writing-job', deleteToken: 'delete-token' });
    getAnalyzeJob.mockResolvedValue({ job: { status: 'done', data: { ...complete, direction: 'writing', material: 'Mandatory reading', imageDesc: 'Chart' } } });
    const { result } = renderHook(() => useHarness());
    await act(async () => { await result.current.runGenerate(undefined, {
      direction: 'writing', chinese: 'Essay question', draft: 'My essay', material: 'Mandatory reading',
      imageDesc: 'Chart', targetWords: 300, title: 'Essay title', lessonKey: 'writing:tem8-2025',
    }); });
    expect(analyze).toHaveBeenCalledWith(expect.objectContaining({ direction: 'writing', chinese: 'Essay question',
      draft: 'My essay', material: 'Mandatory reading', targetWords: 300, book: undefined, lessonId: undefined, original: undefined }));
    expect(loadHistory()[0].lessonKey).toBe('writing:tem8-2025');
    expect(loadHistory()[0].classHomework).toBeFalsy();
    expect(activeHomework).not.toHaveBeenCalled();
    expect(result.current.result.direction).toBe('writing');
    expect(result.current.result.lessonKey).toBe('writing:tem8-2025');
    const writeText = vi.fn().mockResolvedValue();
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    await act(async () => result.current.copyAll());
    expect(writeText.mock.calls[0][0]).toContain('【作文题目】');
    expect(writeText.mock.calls[0][0]).toContain('【写作材料】\nMandatory reading');
    expect(writeText.mock.calls[0][0]).toContain('【高分范文】');
    expect(writeText.mock.calls[0][0]).not.toContain('【中文译文】');
  });
  it('does not replace completed history with a stale pending record during account sync', () => {
    const pending = { jobId: 'same-job', title: '同一作业', time: 1234, status: 'pending', deleteToken: 'token' };
    const done = { jobId: 'same-job', time: 1234, status: 'done' };
    expect(mergeHistory([pending], [done])[0]).toMatchObject({ status: 'done', deleteToken: 'token' });
    expect(mergeHistory([done], [pending])[0].status).toBe('done');
    expect(mergeHistory([pending], [{ ...pending, status: 'error' }])[0].status).toBe('error');
  });
  it('defaults to complete output and records the job before completion', async () => {
    let finish;
    const gate = new Promise((resolve) => { finish = resolve; });
    analyze.mockResolvedValue({ jobId: 'job-default', deleteToken: 'delete-token' });
    getAnalyzeJob.mockImplementation(async () => { await gate; return { job: { status: 'done', data: complete } }; });
    const { result } = renderHook(() => useHarness());
    let task;
    act(() => { task = result.current.runGenerate(); });
    await waitFor(() => expect(loadHistory()[0]?.status).toBe('pending'));
    expect(analyze.mock.calls[0][0].stream).toBe(false);
    expect(result.current.view).toBe('editor');
    expect(result.current.result).toBeNull();
    expect(loadHistory()[0].deleteToken).toBe('delete-token');
    await act(async () => { finish(); await task; });
    expect(result.current.view).toBe('result');
    expect(loadHistory()[0].status).toBe('done');
    expect(loadHistory()).toHaveLength(1);
  });
  it('reopens a pending job without resubmitting or charging again', async () => {
    saveHistory([{ jobId: 'job-resume', title: '已保存作业', status: 'pending', durationMs: 800, time: 1234, lessonKey: 'free' }]);
    getAnalyzeJob.mockResolvedValueOnce({ job: { status: 'running' } }).mockResolvedValue({ job: { status: 'done', data: complete } });
    const { result } = renderHook(() => useHarness());
    await waitFor(() => expect(result.current.view).toBe('result'));
    expect(analyze).not.toHaveBeenCalled();
    expect(result.current.currentJobId).toBe('job-resume');
    expect(result.current.result.workTitle).toBe('已保存作业');
    expect(result.current.result.durationMs).toBe(800);
    expect(loadHistory()[0].status).toBe('done');
  });
  it('polls a pending share link to completion instead of asking the user to refresh', async () => {
    window.history.replaceState(null, '', '#job=share-pending');
    getAnalyzeJob.mockResolvedValueOnce({ job: { status: 'running' } }).mockResolvedValue({ job: { status: 'done', data: complete } });
    const { result } = renderHook(() => useHarness());
    await waitFor(() => expect(result.current.view).toBe('result'));
    expect(analyze).not.toHaveBeenCalled();
    expect(result.current.error).toBe('');
  });
  it('shows a persisted failure distinctly', async () => {
    saveHistory([{ jobId: 'job-failed', title: '失败作业', status: 'pending', time: 1234 }]);
    getAnalyzeJob.mockResolvedValue({ job: { status: 'error', error: '模型暂不可用' } });
    const { result } = renderHook(() => useHarness());
    await waitFor(() => expect(result.current.error).toBe('模型暂不可用'));
    expect(loadHistory()[0].status).toBe('error');
    expect(analyze).not.toHaveBeenCalled();
  });
  it('opens a shared job when only the fragment changes in an already open page', async () => {
    getAnalyzeJob.mockResolvedValue({ job: { status: 'done', data: complete } });
    const { result } = renderHook(() => useHarness());
    act(() => {
      window.history.replaceState(null, '', '#job=another-shared-job');
      window.dispatchEvent(new HashChangeEvent('hashchange'));
    });
    await waitFor(() => expect(result.current.currentJobId).toBe('another-shared-job'));
    expect(result.current.view).toBe('result');
    expect(analyze).not.toHaveBeenCalled();
  });
});
