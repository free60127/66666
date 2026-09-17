/**
 * 前后端共用的**出题上限**（服务端这一份）。
 *
 * 为什么单独一个文件：这几个数字出现在三处 —— 前端选题目量的控件（src/constants.js）、
 * /api/quiz 的入口校验、以及拼给模型的提示词（prompt.mjs 里"题量 = N"那句）。
 * 曾经就踩过：入口校验放宽到 100，提示词里却还写死 `Math.min(50, count)`，
 * 结果用户选了 100 题、模型只被要求出 50 题 —— 界面上一切正常，
 * 只是"说话不算数"，而且两端各自的单测都是绿的。
 *
 * server/quizlimit.test.mjs 会断言这里的值与 src/constants.js 的 MAX_DRILL_COUNT 相等。
 */

/** 一次最多出多少道题（自测题 / 错误训练共用） */
export const MAX_DRILL_COUNT = 100;

/** 一次最多把多少条要点/错题喂给模型。
 *  120 略大于 MAX_DRILL_COUNT：前端按题量精确送点（要 10 道就送 10 条），
 *  这里留一点余量给"题目数 = 要点数"以外的用法，同时挡住超长 payload。 */
export const MAX_DRILL_POINTS = 120;

/** 一次最多批改多少道题（mode=grade）。
 *  比出题上限小得多：只有"本地拿不准的题"才会走到这里（主观题 + 存疑题），
 *  而且它们要和题干、标准答案、学生作答一起进提示词 —— 40 题已经是很大的 payload 了。 */
export const MAX_GRADE_ITEMS = 40;
