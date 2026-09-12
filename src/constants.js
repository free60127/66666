/**
 * 前后端共用的展示常量 + 超时/间隔 —— **改一处就够**。
 *
 * 为什么要有这个文件：轮询间隔、超时、提示停留时间原来散在 20+ 处写死的数字
 * （2500 / 2000 / 1500 / 10*60*1000 / 3*60*1000 …）——
 * 想统一调一次轮询节奏，得先 grep 全仓库，再逐个判断哪个是间隔、哪个是提示时长。
 * 现在按用途命名，改策略只动这里。
 */

/** 等级标签：编辑区、收藏夹、结果页三处共用 */
export const LEVEL_LABEL = { error: '必须改错', improve: '润色升级', study: '对照学习' };

/* ---------- 轮询节奏（毫秒） ---------- */
/** 分析 / 素材：模型要跑 30-120 秒，2.5 秒问一次足够，也不会把接口打爆 */
export const POLL_ANALYZE_MS = 2500;
/** 自测题：出题快，问得密一点 */
export const POLL_QUIZ_MS = 2000;
/** 图片识别：单张 5-30 秒，1.5 秒一次让进度提示更跟手 */
export const POLL_OCR_MS = 1500;

/* ---------- 任务超时（毫秒） ---------- */
/** 分析 / 素材：前端 10 分钟兜底（后端 12 分钟判僵尸，留了 2 分钟余量） */
export const TIMEOUT_ANALYZE_MS = 10 * 60 * 1000;
/** 自测题 */
export const TIMEOUT_QUIZ_MS = 5 * 60 * 1000;
/** 单张图片识别：超过 3 分钟基本就是照片太糊，直接提示重拍 */
export const TIMEOUT_OCR_MS = 3 * 60 * 1000;

/* ---------- 网络容错 ---------- */
/** 连续几次取任务失败才判定网络断了（弱网下不要一抖就报错） */
export const POLL_MAX_FAILURES = 10;

/* ---------- 提示停留时间（毫秒） ---------- */
export const TIP_SHORT_MS = 2000;
export const TIP_NORMAL_MS = 2600;
export const TIP_LONG_MS = 4000;
export const TIP_VERY_LONG_MS = 6000;

/* ---------- 其它 ---------- */
/** 自动同步的防抖：数据变化后等这么久再推（避免连续编辑时反复打接口） */
export const SYNC_PUSH_DEBOUNCE_MS = 8000;
/** 刚同步过多久之内不再自动同步（避免自己触发自己） */
export const SYNC_QUIET_MS = 5000;
