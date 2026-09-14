/**
 * 僵尸任务阈值 vs 前端轮询上限的一致性测试。
 *
 * 为什么单独一条：这两个数字分居两个文件（server/job-stale.mjs、src/constants.js），
 * 谁改都不会报错，只会表现成「用户等到超时、服务端还认为在跑」。原来就是反的
 * （服务端 12 分钟 > 前端 10 分钟），而且没有任何测试看得见。
 *
 * 跑法：node server/jobstale.test.mjs
 */
import { JOB_STALE_BY_KIND, JOB_STALE_MS, staleMsFor } from './job-stale.mjs';
import { TIMEOUT_ANALYZE_MS, TIMEOUT_OCR_MS, TIMEOUT_QUIZ_MS } from '../src/constants.js';

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
};
const min = (ms) => `${ms / 60000} 分钟`;

console.log('=== 僵尸任务阈值一致性测试 ===\n');

/* 每个 kind 对应的前端等待上限 —— 服务端必须先判死 */
const FRONTEND = {
  analyze: TIMEOUT_ANALYZE_MS,
  material: TIMEOUT_ANALYZE_MS,
  quiz: TIMEOUT_QUIZ_MS,
  ocr: TIMEOUT_OCR_MS,
};

for (const [kind, frontendMs] of Object.entries(FRONTEND)) {
  const serverMs = JOB_STALE_BY_KIND[kind];
  check(
    `${kind}：服务端判僵尸早于前端超时（${min(serverMs)} < ${min(frontendMs)}）`,
    Number.isFinite(serverMs) && serverMs < frontendMs,
    Number.isFinite(serverMs) ? '' : '阈值缺失',
  );
}

/* 也不能早得离谱：模型正常要跑 30-120 秒，阈值太小会把正在跑的任务误判成失败 */
for (const [kind, serverMs] of Object.entries(JOB_STALE_BY_KIND)) {
  check(`${kind}：阈值不至于误杀（≥ 2 分钟）`, serverMs >= 2 * 60 * 1000, min(serverMs));
}

check('未知 kind 回退到兜底阈值', staleMsFor('nope') === JOB_STALE_MS, min(staleMsFor('nope')));
check('兜底阈值同样小于最长的前端上限', JOB_STALE_MS < TIMEOUT_ANALYZE_MS, `${min(JOB_STALE_MS)} < ${min(TIMEOUT_ANALYZE_MS)}`);
check('staleMsFor 对已知 kind 返回表里的值', staleMsFor('ocr') === JOB_STALE_BY_KIND.ocr);

console.log('\n' + '='.repeat(62));
const failed = results.filter((r) => !r.ok);
console.log(failed.length ? `❌ ${failed.length}/${results.length} 项失败` : `✅ 全部 ${results.length} 项通过`);
process.exit(failed.length ? 1 : 0);
