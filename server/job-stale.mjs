/**
 * 「僵尸任务」判定阈值。
 *
 * 单独成文件的理由和 server/client-ip.mjs、server/resultShape.mjs 一样：
 * **index.mjs 一被 import 就会 listen**，测试没法直接引用里面的常量。
 * 而这条不变式恰恰是必须被测住的：
 *
 *     服务端判僵尸的阈值  <  前端各自的轮询上限（src/constants.js）
 *
 * 反了会怎样（原来就是反的：服务端 12 分钟、前端 10 分钟）：用户在第 10 分钟就吃到
 * 「等待超时」，服务端却仍认为任务在跑，两边说法不一致；而且客户端已经放弃之后，
 * 任务还在继续调模型、继续花钱，没人会来看它的结果。回归测试见 server/jobstale.test.mjs。
 */

/** 各 kind 的僵尸判定阈值（毫秒），key 与 saveJob 时写入的 kind 一致 */
export const JOB_STALE_BY_KIND = Object.freeze({
  analyze: 8 * 60 * 1000,   // 前端 TIMEOUT_ANALYZE_MS = 10 分钟
  material: 8 * 60 * 1000,  // 前端 TIMEOUT_ANALYZE_MS = 10 分钟
  quiz: 4 * 60 * 1000,      // 前端 TIMEOUT_QUIZ_MS    = 5 分钟
  ocr: 150 * 1000,          // 前端 TIMEOUT_OCR_MS     = 3 分钟
});

/** 未知 kind 的兜底阈值 */
export const JOB_STALE_MS = 8 * 60 * 1000;

export function staleMsFor(kind) {
  return JOB_STALE_BY_KIND[kind] || JOB_STALE_MS;
}
