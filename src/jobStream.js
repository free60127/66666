/**
 * 流式任务订阅（SSE）：把服务端"边生成边推"的内容实时交回调用方。
 *
 * 与姊妹项目「单词本」的流式查词同构：提交任务 → 订阅 /api/xxx/:id/stream →
 * 每收到一段就回调 → `done` 事件带**最终完整结果**（服务端收敛过的），调用方用它覆盖 partial。
 *
 * 三道保险丝（每一条都是实测踩过的死法，不是想出来的）：
 *  · **首段超时**：连上了却一直没有内容（代理缓冲、服务端没起、模型不吐字）→ 回退轮询；
 *  · **停顿超时**：收到过内容之后长时间没有新段（传输被掐 / 生成卡死）→ 回退轮询。
 *    EventSource 对"已有内容"的错误会**永远静默重连**，只靠 onerror 会永久卡住；
 *  · **全程封顶**：无论如何不超过 totalMs（服务端判僵尸的阈值比它略小）。
 *
 * 回退时**用同一个 jobId 走轮询**：任务已经提交、钱已经花了，绝不重复提交。
 *
 * @returns {Promise<{data?:any, fallback?:true, error?:Error, aborted?:true}>}
 */
export const STREAM_FIRST_MS = 25000;          // 首段：作业解析要先读完题干再动笔，给足 25 秒
export const STREAM_STALL_MS = 45000;          // 停顿：正常段间隔只有几秒，45 秒没动静就是断了
export const STREAM_TOTAL_MS = 8 * 60 * 1000;  // 与 server/job-stale.mjs 的 analyze 阈值对齐

export function streamJob({
  jobId, path, onEvent, onFirst, isAlive,
  firstMs = STREAM_FIRST_MS, stallMs = STREAM_STALL_MS, totalMs = STREAM_TOTAL_MS,
  EventSourceImpl = typeof EventSource !== 'undefined' ? EventSource : null,
}) {
  if (!jobId || !EventSourceImpl) return Promise.resolve({ fallback: true, jobId });
  return new Promise((resolve) => {
    let settled = false;
    let gotAny = false;
    let es = null;
    let firstTimer = null;
    let stallTimer = null;
    let totalTimer = null;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(firstTimer);
      clearTimeout(stallTimer);
      clearTimeout(totalTimer);
      try { if (es) es.close(); } catch { /* 已经关了 */ }
      resolve(result);
    };
    const armStall = () => {
      clearTimeout(stallTimer);
      stallTimer = setTimeout(() => finish({ fallback: true, jobId }), stallMs);
    };
    const alive = () => !(isAlive && !isAlive());

    firstTimer = setTimeout(() => { if (!gotAny) finish({ fallback: true, jobId }); }, firstMs);
    totalTimer = setTimeout(() => finish({ fallback: true, jobId }), totalMs);

    try {
      es = new EventSourceImpl(path);
    } catch {
      finish({ fallback: true, jobId });
      return;
    }

    const onNamed = (name, ev) => {
      if (settled) return;
      if (!alive()) { finish({ aborted: true }); return; }
      if (name === 'done') {
        let data = null;
        try { const p = JSON.parse(ev.data); data = p && p.job ? p.job.data : null; } catch { /* 忽略 */ }
        finish({ data });
        return;
      }
      if (name === 'error') {
        let message = '';
        try { message = JSON.parse(ev.data).error || ''; } catch { /* 网络层错误没有 data */ }
        // 服务端明确报错 → 把错误交回去；连接被掐（没有 data）→ 回退轮询，同一个 jobId
        finish(message ? { error: new Error(message), jobId } : { fallback: true, jobId });
        return;
      }
      if (!gotAny) {
        gotAny = true;
        clearTimeout(firstTimer);       // 首段到了：改由"停顿保险丝"接管
        if (onFirst) onFirst();
      }
      let payload = null;
      try { payload = JSON.parse(ev.data); } catch { payload = null; }
      if (onEvent) onEvent(name, payload);
      armStall();
    };

    for (const name of ['segment', 'grade', 'stage']) es.addEventListener(name, (ev) => onNamed(name, ev));
    es.addEventListener('done', (ev) => onNamed('done', ev));
    es.addEventListener('error', (ev) => onNamed('error', ev));

    // EventSource 自身的网络层 error：一段都没收到就立刻回退；已收到内容则交给三道保险丝
    es.onerror = () => {
      if (settled) return;
      if (!gotAny) { finish({ fallback: true, jobId }); return; }
      if (es.readyState === 2 /* CLOSED：浏览器已判定重连无望 */) finish({ fallback: true, jobId });
    };
  });
}
