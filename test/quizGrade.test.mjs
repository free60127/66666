/**
 * 自测卷判分逻辑测试（src/quizGrade.js）。
 *
 * 为什么值得测：判分是这个功能里**唯一会让学生当场信任/不信任**的东西 ——
 * 写对了判错（标点、大小写、全角半角、另一种译法）比不批改更糟。
 * 这里的断言全是纯函数层面的，覆盖"模型写答案的三种习惯"和"学生作答的各种脏写法"。
 *
 * 跑法：node test/quizGrade.test.mjs
 */
import {
  answerLetter, answerVariants, gradingMode, judgeLocally, needsAI, needsAIGrade,
  normalizeAnswer, optionLabel, optionText, similarity, summarizeVerdicts,
} from '../src/quizGrade.js';

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
};

console.log('=== 自测卷判分测试 ===\n');

/* ---------- 1. 归一化：标点/大小写/全角都不该算差异 ---------- */
{
  check('大小写与句末标点不影响判等', normalizeAnswer('Swung round.') === normalizeAnswer('swung round'));
  check('全角标点 / 弯引号 / 多余空白都归一', normalizeAnswer('It’s  a　test！') === normalizeAnswer("it's a test"), normalizeAnswer('It’s  a　test！'));
  check('空值不炸', normalizeAnswer(null) === '' && normalizeAnswer(undefined) === '');
}

/* ---------- 2. 一个标准答案里的多种写法 ---------- */
{
  const v = answerVariants('swing / swung');
  check('斜杠分隔的两种写法都算对', v.includes('swing') && v.includes('swung'), JSON.stringify(v));
  check('中文分号 / "或" 也拆', answerVariants('on；upon').length === 2 && answerVariants('by bus 或 on foot').length === 2);
  check('括号里的补充说明单独算一种写法', answerVariants('swing（过去式 swung）').includes('swung'), JSON.stringify(answerVariants('swing（过去式 swung）')));
  check('空答案拆出来是空数组', answerVariants('').length === 0);
}

/* ---------- 3. 相似度 ---------- */
{
  check('完全相同 = 1', similarity('I went home', 'I went home') === 1);
  check('词序不同仍然很高', similarity('I went home quickly', 'Quickly I went home') > 0.7);
  check('改对一处 → 高分（不会被判错）', similarity(
    'When the man tried to swing the speedboat round, the steering wheel slipped from his grasp.',
    'When the man tried to swing the speedboat round, the controller slipped from his hands.',
  ) > 0.7, String(similarity(
    'When the man tried to swing the speedboat round, the steering wheel slipped from his grasp.',
    'When the man tried to swing the speedboat round, the controller slipped from his hands.',
  )));
  check('答非所问 → 低分', similarity('I like apples', 'The steering wheel slipped') < 0.3);
  check('一边为空 → 0', similarity('', 'anything') === 0);
}

/* ---------- 4. 选择题：选项与答案的对应 ---------- */
{
  const q = { type: '选择', options: ['A. swerve', 'B. swing', 'C. sway', 'D. sweep'], answer: 'B' };
  check('选项自带字母', optionLabel(q.options[1], 1) === 'B' && optionText(q.options[1]) === 'swing');
  check('答案是裸字母', answerLetter(q) === 'B');
  check('答案是「B. swing」', answerLetter({ ...q, answer: 'B. swing' }) === 'B');
  check('答案是选项正文「swing」', answerLetter({ ...q, answer: 'swing' }) === 'B');
  check('选项没带字母时按位置补 A/B/C/D', answerLetter({ type: '选择', options: ['swerve', 'swing', 'sway'], answer: 'swing' }) === 'B');
  check('认不出答案时返回空串（调用方退化处理）', answerLetter({ type: '选择', options: ['a', 'b'], answer: '无从判断' }) === '');
}

/* ---------- 5. 题型 → 判分方式 ---------- */
{
  check('有 4 个选项 → 选择', gradingMode({ type: '选择', options: ['A. x', 'B. y'], answer: 'B' }) === 'choice');
  check('改错 → fix', gradingMode({ type: '改错', options: [], answer: 'I went.' }) === 'fix');
  check('填空 → blank', gradingMode({ type: '填空', options: [], answer: 'on' }) === 'blank');
  check('翻译（答案是单词）→ 本地可判', gradingMode({ type: '翻译', options: [], answer: 'spoil' }) === 'blank');
  check('翻译（答案是一整句）→ 交给 AI', gradingMode({ type: '翻译', options: [], answer: 'He waved desperately to his companion.' }) === 'subjective');
  check('造句 → 交给 AI', needsAI({ type: '造句', options: [], answer: 'I swung the boat round.' }) === true);
}

/* ---------- 6. 判分：选择 / 填空 / 改错 ---------- */
{
  const choice = { type: '选择', options: ['A. swerve', 'B. swing', 'C. sway', 'D. sweep'], answer: 'B' };
  check('选对 → 对', judgeLocally(choice, 'B').status === 'right');
  check('选错 → 错', judgeLocally(choice, 'A').status === 'wrong');

  const blank = { type: '填空', options: [], answer: 'steering wheel' };
  check('填空写对（大小写/标点无关）→ 对', judgeLocally(blank, 'Steering Wheel.').status === 'right');
  check('填空拼错一点 → 接近（不是错）', judgeLocally(blank, 'steering weel').status === 'close', judgeLocally(blank, 'steering weel').status);
  check('填空写成别的 → 错', judgeLocally(blank, 'gas pedal').status === 'wrong');
  check('填空把整句抄进来 → 接近（提示只需填空格处）', judgeLocally({ type: '填空', options: [], answer: 'on' }, 'It depends on the weather').status === 'close');
  check('填空答案写了两种写法，命中任一种都算对', judgeLocally({ type: '填空', options: [], answer: 'swing / swung' }, 'swung').status === 'right');

  const fix = { type: '改错', options: [], answer: 'When the man tried to swing the speedboat round, the steering wheel slipped from his grasp.' };
  check('改错与标准答案一致 → 对', judgeLocally(fix, 'When the man tried to swing the speedboat round, the steering wheel slipped from his grasp.').status === 'right');
  check('改错改了对的地方、其余表达不同 → 接近', judgeLocally(fix, 'When the man tried to swing the speedboat round, the steering wheel slipped from his hands.').status === 'close');
  check('改错完全没改到 → 错', judgeLocally(fix, 'I like apples and bananas.').status === 'wrong');

  check('没作答 → 直接判错（不必费一次 AI 调用）', judgeLocally(blank, '').status === 'wrong' && judgeLocally(blank, '').reason === 'empty');
  check('标准答案为空 → 不本地判（交给 AI / 自评）', judgeLocally({ type: '填空', options: [], answer: '' }, 'x') === null);
  check('主观题 → 不本地判', judgeLocally({ type: '造句', options: [], answer: 'I swung the boat round.' }, '随便写点什么') === null);
}

/* ---------- 7. 汇总（底部进度/得分） ---------- */
{
  const s = summarizeVerdicts({ 0: { status: 'right' }, 1: { status: 'close' }, 2: { status: 'wrong' } }, 5);
  check('三档计数正确', s.right === 1 && s.close === 1 && s.wrong === 1 && s.judged === 3 && s.unjudged === 2, JSON.stringify(s));
  const e = summarizeVerdicts({}, 4);
  check('一题没判时是干净的零', e.judged === 0 && e.unjudged === 4 && e.right === 0);
  const p = summarizeVerdicts({ 0: { status: 'pending' }, 1: { status: 'right' } }, 3);
  check('「待自评」单列，不算已批改也不算没做', p.selfPending === 1 && p.judged === 1 && p.unjudged === 1, JSON.stringify(p));
}

/* ---------- 8. 哪些题要再请 AI 复核 ---------- */
{
  const choice = { type: '选择', options: ['A. x', 'B. y'], answer: 'B' };
  const blank = { type: '填空', options: [], answer: 'on' };
  const fix = { type: '改错', options: [], answer: 'I went to the theatre last week.' };
  const write = { type: '造句', options: [], answer: 'I swung the boat round.' };
  check('主观题一定要 AI（本地判不了）', needsAIGrade(write, null) === true);
  check('本地判「接近」的要复核', needsAIGrade(blank, { status: 'close' }) === true);
  check('选择题判错就是错，不必再花钱', needsAIGrade(choice, { status: 'wrong' }) === false);
  check('普通填空判错也不必复核', needsAIGrade(blank, { status: 'wrong' }) === false);
  check('改错判「错」要复核（改法不止一种，相似度认不出来）', needsAIGrade(fix, { status: 'wrong' }) === true);
  check('已经判对的题不再送', needsAIGrade(blank, { status: 'right' }) === false);
}

const failed = results.filter((r) => !r.ok);
console.log('\n' + '='.repeat(60));
console.log(failed.length ? `❌ ${failed.length} / ${results.length} 项失败` : `✅ 全部 ${results.length} 项通过`);
if (failed.length) {
  for (const f of failed) console.log('  FAILED: ' + f.name + (f.detail ? '  — ' + f.detail : ''));
  process.exitCode = 1;
}
