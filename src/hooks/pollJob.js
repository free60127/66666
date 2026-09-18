import { streamJob } from '../jobStream.js';

/**
 * 统一的异步任务轮询（分析 / 素材 / 自测题 / OCR 共用）。
 *
 * 抽出来的原因：四处原来各写了一份逐字重复的循环（sleep → 取任务 → 失败计数 →
 * deadline → done/error），差别只有间隔、超时和文案 —— 改一处要记得改四处。
 *
 * @returns {Promise<{data?: any, aborted?: true}>} 组件已卸载时返回 { aborted: true }
 */
export async function pollJob({ jobId, fetchJob, intervalMs, timeoutMs, maxFailures, netError, timeoutError, onProgress, isAlive }) {
  /**
   * 计时只算「页面在前台」的时间。
   *
   * 手机锁屏 / 切到别的 App 时，浏览器会冻结定时器：墙上时钟照走，但一次轮询都没发生。
   * 原来用的是纯墙钟 deadline，于是用户锁屏 12 分钟回来只看到「生成超时，请重新提交」——
   * 而服务端其实早就跑完了；更糟的是超时分支从不进 onData，本机历史里连这条记录都没有，
   * 用户没有任何入口找回这次批改，只能再花一次钱。
   *
   * 现在把「隐藏时长」从已用时间里扣掉：回到前台后继续轮询，跑完照常出结果。
   * 页面隐藏期间不额外延长 timeoutMs 之外的时间 —— 只是不把它算作等待。
   */
  const startedAt = Date.now();
  let hiddenMs = 0;
  let hiddenSince = typeof document !== 'undefined' && document.hidden ? Date.now() : 0;
  const onVisibility = () => {
    if (document.hidden) { if (!hiddenSince) hiddenSince = Date.now(); }
    else if (hiddenSince) { hiddenMs += Date.now() - hiddenSince; hiddenSince = 0; }
  };
  const canListen = typeof document !== 'undefined' && typeof document.addEventListener === 'function';
  if (canListen) document.addEventListener('visibilitychange', onVisibility);
  /** 已用的"前台时间"（毫秒） */
  const activeElapsed = () => Date.now() - startedAt - hiddenMs - (hiddenSince ? Date.now() - hiddenSince : 0);

  let failures = 0;
  try {
    while (activeElapsed() < timeoutMs) {
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
      if (isAlive && !isAlive()) return { aborted: true };
      let r;
      try {
        r = await fetchJob(jobId);
        failures = 0;
      } catch {
        failures += 1;
        if (failures > maxFailures) throw new Error(netError);
        continue;
      }
      const job = r && r.job;
      if (!job) continue;
      if (job.status === 'done') return { data: job.data };
      if (job.status === 'error') throw new Error(job.error || '任务失败，请重试');
      if (onProgress) onProgress(job);
    }
  } finally {
    if (canListen) document.removeEventListener('visibilitychange', onVisibility);
  }
  throw new Error(timeoutError);
}

/**
 * 提交任务 + 轮询到结束 —— 四条链路（分析 / 素材 / 自测题 / OCR）共用的前半段。
 *
 * 之前每处都要自己写六行完全相同的 pollJob 参数（间隔/超时/失败阈值/两句错误文案），
 * 参数写错（比如忘了 maxFailures）不会报错，只会表现成"偶尔卡住"。收到这里之后，
 * 调用方只管 submit 什么、拿到 data 做什么。
 *
 * 传了 `stream` 时先走流式（SSE）：边生成边回调，学生在结果页上看着内容长出来；
 * 流式不可用/中途断了就**用同一个 jobId 回退到轮询**（不重复提交、不重复计费）。
 * 两条路最终都以「服务端收敛过的完整 data」收尾，所以下游（历史 / 进度 / 分享）不用分叉。
 *
 * @returns {Promise<{data?: any, aborted?: true}>}
 */
export async function submitAndPoll({ submit, fetchJob, intervalMs, timeoutMs, maxFailures, netError, timeoutError, isAlive, onProgress, onJobId, stream }) {
  const resp = await submit();
  const jobId = resp && resp.jobId;
  // 少数情况服务端会直接同步返回结果（没有任务号）：当作已完成，不再轮询
  if (!jobId && resp && resp.data) return { data: resp.data };
  if (!jobId) throw new Error('服务器未返回任务编号，请重试');
  if (onJobId) onJobId(jobId);
  if (stream) {
    const r = await streamJob({
      jobId,
      path: typeof stream.path === 'function' ? stream.path(jobId) : stream.path,
      onEvent: stream.onEvent,
      onFirst: () => {
        // 首段到达 = 真的在流式了：调用方据此切视图/显示"正在生成"横幅，runner 据此进第 2 步
        if (stream.onFirst) stream.onFirst();
        if (onProgress) onProgress({ status: 'running', streamed: true });
      },
      isAlive,
      firstMs: stream.firstMs,
      stallMs: stream.stallMs,
      totalMs: stream.totalMs,
    });
    if (r.aborted) return { aborted: true };
    if (r.error) throw r.error;
    if (r.data) return { data: r.data };
    // fallback → 继续往下走轮询（同一个 jobId，费用不重复）
  }
  return pollJob({ jobId, fetchJob, intervalMs, timeoutMs, maxFailures, netError, timeoutError, isAlive, onProgress });
}
