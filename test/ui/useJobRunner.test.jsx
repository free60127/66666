/**
 * useJobRunner 单测（四条生成链路共用的"任务生命周期 + 秒表 + 状态文案"）。
 *
 * 为什么值得测：它把 busy / step / message / 计时器 绑在一起，任何一处没复位
 * 都会留下"按钮一直转圈"或"进度条卡在 66%"这类用户可见的残留。
 * 这里钉住：状态推进顺序、成功保留"完成"态、失败复位、取消等待只解锁界面不停轮询。
 */
import { describe, it, expect, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { useJobRunner } from '../../src/hooks/useJobRunner.js';

const texts = { submit: '正在提交…', running: '生成中…', done: '完成' };
const fast = { intervalMs: 1, timeoutMs: 500, maxFailures: 2, netError: '网络不稳定', timeoutError: '超时了', texts };

describe('useJobRunner', () => {
  it('成功链路：busy → 完成态，并回调 onData', async () => {
    const onData = vi.fn(async () => 'processed');
    const { result } = renderHook(() => useJobRunner());
    let ret;
    await act(async () => {
      ret = await result.current.run({
        ...fast,
        submit: async () => ({ jobId: 'j1' }),
        fetchJob: async () => ({ job: { status: 'done', data: { score: 72 } } }),
        onData,
      });
    });
    expect(ret.data).toEqual({ score: 72 });
    expect(ret.value).toBe('processed');
    expect(onData).toHaveBeenCalledWith({ score: 72 });
    expect(result.current.busy).toBe(false);   // 结束一定解锁
    expect(result.current.step).toBe(3);       // 成功保留"完成"态（供进度条显示 100%）
    expect(result.current.message).toBe('完成');
  });

  it('失败链路：异常照常抛出，且进度状态复位', async () => {
    const { result } = renderHook(() => useJobRunner());
    await act(async () => {
      await expect(result.current.run({
        ...fast,
        submit: async () => ({ jobId: 'j2' }),
        fetchJob: async () => ({ job: { status: 'error', error: '模型返回不完整' } }),
      })).rejects.toThrow('模型返回不完整');
    });
    expect(result.current.busy).toBe(false);
    expect(result.current.step).toBe(0);       // 失败要复位，否则进度条停在半路
    expect(result.current.message).toBe('');
  });

  it('onJobId 拿得到任务号', async () => {
    const onJobId = vi.fn();
    const { result } = renderHook(() => useJobRunner());
    await act(async () => {
      await result.current.run({
        ...fast, onJobId,
        submit: async () => ({ jobId: 'job-xyz' }),
        fetchJob: async () => ({ job: { status: 'done', data: 1 } }),
      });
    });
    expect(onJobId).toHaveBeenCalledWith('job-xyz');
  });

  it('取消等待：界面立刻解锁，但后台轮询继续直到出结果', async () => {
    const { result } = renderHook(() => useJobRunner());
    let resolveJob;
    const gate = new Promise((r) => { resolveJob = r; });
    let runPromise;
    act(() => {
      runPromise = result.current.run({
        ...fast,
        submit: async () => ({ jobId: 'j3' }),
        fetchJob: async () => { await gate; return { job: { status: 'done', data: 'late' } }; },
      });
    });
    await waitFor(() => expect(result.current.busy).toBe(true));
    act(() => result.current.cancelWait());
    expect(result.current.busy).toBe(false);   // 界面解锁
    expect(result.current.step).toBe(0);
    let ret;
    await act(async () => { resolveJob(); ret = await runPromise; });
    expect(ret.data).toBe('late');             // 后台仍然拿到了结果
  });

  it('reset 清空全部状态', async () => {
    const { result } = renderHook(() => useJobRunner());
    await act(async () => {
      await result.current.run({
        ...fast,
        submit: async () => ({ jobId: 'j4' }),
        fetchJob: async () => ({ job: { status: 'done', data: 1 } }),
      });
    });
    act(() => result.current.reset());
    expect(result.current.busy).toBe(false);
    expect(result.current.step).toBe(0);
    expect(result.current.message).toBe('');
    expect(result.current.elapsed).toBe(0);
  });
});
