/**
 * 统一的异步任务轮询（分析 / 素材 / 自测题 / OCR 共用）。
 *
 * 抽出来的原因：四处原来各写了一份逐字重复的循环（sleep → 取任务 → 失败计数 →
 * deadline → done/error），差别只有间隔、超时和文案 —— 改一处要记得改四处。
 *
 * @returns {Promise<{data?: any, aborted?: true}>} 组件已卸载时返回 { aborted: true }
 */
export async function pollJob({ jobId, fetchJob, intervalMs, timeoutMs, maxFailures, netError, timeoutError, onProgress, isAlive }) {
  const deadline = Date.now() + timeoutMs;
  let failures = 0;
  while (Date.now() < deadline) {
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
  throw new Error(timeoutError);
}
