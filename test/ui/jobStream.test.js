/**
 * 流式订阅（src/jobStream.js）的单测。
 *
 * 这里测的是**三道保险丝**和回退语义 —— 全是最容易写错、又最难在真机上复现的部分：
 * 首段超时、中途停顿、EventSource 不可用（老浏览器/被代理拦）、服务端明确报错、
 * 以及"组件已经卸载就别再回调"。写错了的表现是"偶尔卡住不动"，用户只会觉得"这软件抽风"。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { streamJob } from '../../src/jobStream.js';

/** 可控的假 EventSource：手动触发事件，能看 readyState */
class FakeES {
  static instances = [];
  constructor(url) {
    this.url = url;
    this.readyState = 0;
    this.listeners = {};
    FakeES.instances.push(this);
  }
  addEventListener(name, fn) { (this.listeners[name] = this.listeners[name] || []).push(fn); }
  close() { this.closed = true; this.readyState = 2; }
  emit(name, data) {
    const ev = { data: typeof data === 'string' ? data : JSON.stringify(data) };
    (this.listeners[name] || []).forEach((fn) => fn(ev));
  }
  /** 模拟网络层错误（没有 data） */
  fail() { this.readyState = 2; if (this.onerror) this.onerror({}); }
}

const last = () => FakeES.instances[FakeES.instances.length - 1];

beforeEach(() => { FakeES.instances = []; vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe('streamJob：正常路径', () => {
  it('段事件实时回调，done 带最终结果收尾', async () => {
    const seen = [];
    const p = streamJob({
      jobId: 'j1', path: '/api/analyze/j1/stream', EventSourceImpl: FakeES,
      onEvent: (name, payload) => seen.push([name, payload && payload.seg && payload.seg.t]),
    });
    last().emit('segment', { index: 0, seg: { t: 'meta' } });
    last().emit('segment', { index: 1, seg: { t: 'sentence' } });
    last().emit('done', { job: { data: { sentences: [{ cn: 'x' }] } } });
    const r = await p;
    expect(seen).toEqual([['segment', 'meta'], ['segment', 'sentence']]);
    expect(r.data.sentences).toHaveLength(1);
    expect(last().closed).toBe(true);
  });

  it('首发事件会通知调用方（用来切结果页 / 显示"正在生成"横幅）', async () => {
    const onFirst = vi.fn();
    const p = streamJob({ jobId: 'j1', path: '/x', EventSourceImpl: FakeES, onEvent: () => {}, onFirst });
    expect(onFirst).not.toHaveBeenCalled();
    last().emit('segment', { index: 0, seg: { t: 'meta' } });
    expect(onFirst).toHaveBeenCalledTimes(1);
    last().emit('segment', { index: 1, seg: { t: 'ai' } });
    expect(onFirst).toHaveBeenCalledTimes(1);   // 只报一次
    last().emit('done', { job: { data: {} } });
    await p;
  });

  it('服务端明确报错 → 把错误原样交回去（不静默回退成轮询）', async () => {
    const p = streamJob({ jobId: 'j1', path: '/x', EventSourceImpl: FakeES, onEvent: () => {} });
    last().emit('error', { error: '模型接口错误 500: boom' });
    const r = await p;
    expect(r.error).toBeInstanceOf(Error);
    expect(r.error.message).toMatch(/模型接口错误/);
    expect(r.fallback).toBeUndefined();
  });
});

describe('streamJob：三道保险丝', () => {
  it('★ 首段超时（连上了但一直没内容）→ 回退轮询', async () => {
    const p = streamJob({ jobId: 'j1', path: '/x', EventSourceImpl: FakeES, onEvent: () => {}, firstMs: 1000 });
    await vi.advanceTimersByTimeAsync(999);
    expect(last().closed).toBeFalsy();
    await vi.advanceTimersByTimeAsync(2);
    const r = await p;
    expect(r.fallback).toBe(true);
    expect(r.jobId).toBe('j1');      // 回退要带同一个 jobId：不重复提交、不重复计费
    expect(last().closed).toBe(true);
  });

  it('★ 中途停顿（收到过内容后再无新段）→ 回退轮询', async () => {
    const p = streamJob({ jobId: 'j1', path: '/x', EventSourceImpl: FakeES, onEvent: () => {}, stallMs: 2000, firstMs: 1000 });
    last().emit('segment', { index: 0, seg: { t: 'meta' } });
    await vi.advanceTimersByTimeAsync(1999);
    last().emit('segment', { index: 1, seg: { t: 'ai' } });   // 有新内容 → 保险丝重置
    await vi.advanceTimersByTimeAsync(1500);
    expect(last().closed).toBeFalsy();
    await vi.advanceTimersByTimeAsync(600);
    expect((await p).fallback).toBe(true);
  });

  it('★ 全程封顶：无论卡在哪一步都会交回轮询', async () => {
    const p = streamJob({ jobId: 'j1', path: '/x', EventSourceImpl: FakeES, onEvent: () => {}, totalMs: 5000, stallMs: 100000 });
    last().emit('segment', { index: 0, seg: { t: 'meta' } });
    await vi.advanceTimersByTimeAsync(5001);
    expect((await p).fallback).toBe(true);
  });

  it('一段都没收到就断线（服务端没起/被代理拦）→ 立刻回退，不干等', async () => {
    const p = streamJob({ jobId: 'j1', path: '/x', EventSourceImpl: FakeES, onEvent: () => {} });
    last().fail();
    expect((await p).fallback).toBe(true);
  });

  it('EventSource 不可用（老浏览器）→ 直接回退，绝不抛错', async () => {
    const r = await streamJob({ jobId: 'j1', path: '/x', EventSourceImpl: null, onEvent: () => {} });
    expect(r.fallback).toBe(true);
  });

  it('没有 jobId → 回退（不白建连接）', async () => {
    const r = await streamJob({ jobId: '', path: '/x', EventSourceImpl: FakeES, onEvent: () => {} });
    expect(r.fallback).toBe(true);
    expect(FakeES.instances).toHaveLength(0);
  });
});

describe('streamJob：生命周期', () => {
  it('组件已卸载（isAlive=false）→ 收尾为 aborted，不再回调', async () => {
    const onEvent = vi.fn();
    let alive = true;
    const p = streamJob({ jobId: 'j1', path: '/x', EventSourceImpl: FakeES, onEvent, isAlive: () => alive });
    last().emit('segment', { index: 0, seg: { t: 'meta' } });
    expect(onEvent).toHaveBeenCalledTimes(1);
    alive = false;
    last().emit('segment', { index: 1, seg: { t: 'ai' } });
    const r = await p;
    expect(r.aborted).toBe(true);
    expect(onEvent).toHaveBeenCalledTimes(1);
    expect(last().closed).toBe(true);
  });

  it('坏 JSON 的段不会炸掉整条流（只是这一段不渲染）', async () => {
    const onEvent = vi.fn();
    const p = streamJob({ jobId: 'j1', path: '/x', EventSourceImpl: FakeES, onEvent });
    last().emit('segment', '{不是 JSON');
    last().emit('segment', { index: 1, seg: { t: 'ai' } });
    expect(onEvent).toHaveBeenCalledTimes(2);
    expect(onEvent.mock.calls[0][1]).toBe(null);
    last().emit('done', { job: { data: {} } });
    await p;
  });
});
