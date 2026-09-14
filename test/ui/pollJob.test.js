/**
 * pollJob / submitAndPoll 单测（异步任务轮询的统一实现）。
 *
 * 为什么值得测：四条生成链路（批改 / 素材 / 自测题 / OCR）全走这一份代码，
 * 而它的失败模式很隐蔽 —— 参数写错不会报错，只会表现成"偶尔卡住"或"永远转圈"。
 * 这里把五条分支都钉住：完成 / 任务失败 / 网络连续失败 / 超时 / 组件卸载中止。
 */
import { describe, it, expect, vi } from 'vitest';
import { pollJob, submitAndPoll } from '../../src/hooks/pollJob.js';

const base = { intervalMs: 1, timeoutMs: 200, maxFailures: 2, netError: '网络不稳定', timeoutError: '超时了' };

describe('pollJob', () => {
  it('任务完成时返回结果', async () => {
    let n = 0;
    const r = await pollJob({
      ...base, jobId: 'j1',
      fetchJob: async () => ({ job: { status: n++ === 0 ? 'running' : 'done', data: { score: 72 } } }),
    });
    expect(r.data).toEqual({ score: 72 });
  });

  it('任务失败时抛出服务端给的原因', async () => {
    await expect(pollJob({
      ...base, jobId: 'j2',
      fetchJob: async () => ({ job: { status: 'error', error: '模型返回不完整' } }),
    })).rejects.toThrow('模型返回不完整');
  });

  it('任务失败但服务端没给原因时用兜底文案', async () => {
    await expect(pollJob({
      ...base, jobId: 'j3',
      fetchJob: async () => ({ job: { status: 'error' } }),
    })).rejects.toThrow('任务失败，请重试');
  });

  it('网络连续失败超过阈值后报错', async () => {
    await expect(pollJob({
      ...base, jobId: 'j4', maxFailures: 2,
      fetchJob: async () => { throw new Error('boom'); },
    })).rejects.toThrow('网络不稳定');
  });

  it('偶发网络失败会被容忍（不达阈值就继续轮询）', async () => {
    let n = 0;
    const r = await pollJob({
      ...base, jobId: 'j5', maxFailures: 3,
      fetchJob: async () => {
        n += 1;
        if (n === 1) throw new Error('偶发');
        return { job: { status: 'done', data: { ok: true } } };
      },
    });
    expect(r.data).toEqual({ ok: true });
  });

  it('超时（一直 pending）会抛超时文案', async () => {
    await expect(pollJob({
      ...base, jobId: 'j6', timeoutMs: 30,
      fetchJob: async () => ({ job: { status: 'pending' } }),
    })).rejects.toThrow('超时了');
  });

  it('页面被切到后台（手机锁屏）的时间不计入超时', async () => {
    // 真机场景：点生成 → 锁屏 / 切微信十几分钟 → 回来。
    // 浏览器在后台会冻结定时器：墙上时钟照走，但一次轮询都没发生。
    // 用纯墙钟 deadline 的话，用户回来只看到「超时」，而服务端其实早跑完了；
    // 更糟的是超时分支不进 onData，本机历史里连这条记录都没有 —— 等于白花一次钱。
    //
    // 关键设计：任务在**回到前台之后**才完成。否则它在超时前就结束了，这条测试
    // 对旧实现也会通过（第一版就踩了这个坑，旧实现照样绿）。
    let hidden = false;
    let finish = false;
    const spy = vi.spyOn(document, 'hidden', 'get').mockImplementation(() => hidden);
    const fire = () => document.dispatchEvent(new Event('visibilitychange'));
    const p = pollJob({
      intervalMs: 5, timeoutMs: 120, maxFailures: 3, netError: '网络不稳定', timeoutError: '超时了',
      jobId: 'j-hide',
      fetchJob: async () => (finish ? { job: { status: 'done', data: { ok: 'after-hide' } } } : { job: { status: 'running' } }),
    });
    // 先立刻接住结果，避免旧实现提前 reject 变成 unhandled rejection
    const settled = p.then((v) => ({ v }), (e) => ({ e }));

    await new Promise((r) => setTimeout(r, 40));   // 消耗一部分前台时间
    hidden = true; fire();
    await new Promise((r) => setTimeout(r, 260));  // 后台停留 260ms：墙钟已 300ms > 120ms
    hidden = false; fire();
    finish = true;                                  // 回到前台之后才完成

    const out = await settled;
    expect(out.e).toBeUndefined();                  // 不该判超时
    expect(out.v.data).toEqual({ ok: 'after-hide' });
    spy.mockRestore();
  });

  it('组件已卸载时返回 aborted，不再继续轮询', async () => {
    const fetchJob = vi.fn(async () => ({ job: { status: 'pending' } }));
    const r = await pollJob({ ...base, jobId: 'j7', fetchJob, isAlive: () => false });
    expect(r).toEqual({ aborted: true });
    expect(fetchJob).not.toHaveBeenCalled();
  });

  it('响应里没有 job 字段时继续轮询而不是崩', async () => {
    let n = 0;
    const r = await pollJob({
      ...base, jobId: 'j8',
      fetchJob: async () => (n++ === 0 ? {} : { job: { status: 'done', data: 1 } }),
    });
    expect(r.data).toBe(1);
  });
});

describe('submitAndPoll', () => {
  it('提交后拿到 jobId 再轮询', async () => {
    const onJobId = vi.fn();
    const r = await submitAndPoll({
      ...base, submit: async () => ({ jobId: 'abc' }),
      fetchJob: async () => ({ job: { status: 'done', data: 'ok' } }),
      onJobId,
    });
    expect(r.data).toBe('ok');
    expect(onJobId).toHaveBeenCalledWith('abc');
  });

  it('服务端直接同步返回结果时不再轮询', async () => {
    const fetchJob = vi.fn();
    const r = await submitAndPoll({ ...base, submit: async () => ({ data: { sync: true } }), fetchJob });
    expect(r.data).toEqual({ sync: true });
    expect(fetchJob).not.toHaveBeenCalled();
  });

  it('两个都没有时报"未返回任务编号"', async () => {
    await expect(submitAndPoll({ ...base, submit: async () => ({}), fetchJob: async () => ({}) }))
      .rejects.toThrow('服务器未返回任务编号');
  });
});
