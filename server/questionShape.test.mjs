/**
 * 出题形状清洗测试（server/questionShape.mjs）。
 *
 * 为什么必须有：这两类毛病**只在真实模型上偶发**，而且不报错、不崩 ——
 * 只是让学生没法做题。用户实测反馈的两个例子（2026-09-17 截图）就是这里的头两条用例：
 *   · 填空题把**中文提示**也挖了空：「当那人试图让快艇转弯时，____ 脱手了」→ 无从下手
 *   · 同一句英文先出「填空」再出「改错」→ 两道题考同一处错，等于重复劳动
 *
 * 跑法：node server/questionShape.test.mjs
 */
import { blankInChinese, isIncompleteQuestion, sanitizeGrades, sanitizeQuestions, sourceSentence } from './questionShape.mjs';

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
};

/* ---------- 中文被挖空：用户截图里那道题 ---------- */
{
  const bad = '根据中文提示填空：当那人试图让快艇转弯时，____ 脱手了。\nWhen the man tried to swing the speedboat round, the steering wheel slipped from his grasp.';
  const good = '根据中文提示填空：当那人试图让快艇转弯时，舵轮脱手了。\nWhen the man tried to swing the speedboat round, the ____ slipped from his grasp.';
  check('★ 中文提示被挖空 → 判为不合格（用户截图里那道题）', blankInChinese(bad) === true);
  check('英文里挖空 → 合格（前后都是英文字母）', blankInChinese(good) === false);
  check('全角下划线也算挖空', blankInChinese('当那人＿＿脱手了') === true);
  check('空括号算挖空', blankInChinese('他（　）地挥手') === true);
  check('没有空 → 当然不算', blankInChinese('改正下列句子中的错误：He waved desperately.') === false);
  check('空在句末英文后（下一个是换行）→ 不算中文挖空', blankInChinese('Fill in: the steering wheel ____') === false);
  check('空值不炸', blankInChinese('') === false && blankInChinese(null) === false);
}

/* ---------- 同句去重：用户说"4 和 5 不是一道题吗" ---------- */
{
  const key = sourceSentence('When the man tried to swing the speedboat round, the ____ slipped from his grasp.');
  check('能从题干里认出"考的是哪句英文"', key.includes('when the man tried to swing the speedboat round'), key.slice(0, 60));
  check('填空与改错同一句 → 认出同一个 key',
    sourceSentence('When the man tried to swing the speedboat round, the ____ slipped from his grasp.')
    === sourceSentence('改正下列句子中的错误：When the man tried to swing the speedboat round, the steering wheel slipped from his grasp.'));
  check('太短的不认（避免把选项当句子）', sourceSentence('A. looked for') === '');
}

/* ---------- sanitizeQuestions：整体行为 ---------- */
{
  const q = (type, question, answer = 'A') => ({ type, question, options: [], answer, explanation: 'e', source: 's' });
  const list = [
    q('填空', '根据中文提示填空：当那人试图让快艇转弯时，____ 脱手了。\nWhen the man tried to swing the speedboat round, the steering wheel slipped from his grasp.'),
    q('改错', '改正下列句子中的错误：When the man tried to swing the speedboat round, the steering wheel slipped from his grasp.'),
    q('填空', '根据中文提示填空：当那人试图让快艇转弯时，舵轮脱手了。\nWhen the man tried to swing the speedboat round, the ____ slipped from his grasp.'),
    q('改错', '改正下列句子中的错误：He waved desperately to his companion.'),
    q('翻译', '把这句话译成英文：「他绝望地向他的伙伴挥手。」'),
    { type: '造句', question: '', answer: '', explanation: '', source: '' },
  ];
  const { questions, dropped } = sanitizeQuestions(list, { count: 10, drill: true });
  check('丢掉"中文被挖空"的那道题', dropped.chineseBlank === 1, `丢弃 ${dropped.chineseBlank} 条`);
  check('丢掉"同一句重复"的那道题', dropped.duplicate === 1, `丢弃 ${dropped.duplicate} 条`);
  check('丢掉半条（题干/答案为空）', dropped.incomplete === 1, `丢弃 ${dropped.incomplete} 条`);
  check('剩下的题都保住了（3 道）', questions.length === 3, `剩 ${questions.length} 道：${questions.map((x) => x.type).join('/')}`);
  check('留下的题库型仍然多样', new Set(questions.map((x) => x.type)).size >= 2, questions.map((x) => x.type).join('/'));

  const capped = sanitizeQuestions([q('改错', 'One two three four five.'), q('改错', 'Six seven eight nine ten.')], { count: 1, drill: true });
  check('题量超出要求时截断（模型偶尔多给）', capped.questions.length === 1 && capped.dropped.over === 1);

  const notDrill = sanitizeQuestions(list, { count: 10, drill: false });
  check('自测题模式不套用这两条规则（题干本来就是知识点，不适用）',
    notDrill.dropped.chineseBlank === 0 && notDrill.dropped.duplicate === 0 && notDrill.questions.length === 5,
    `剩 ${notDrill.questions.length} 道`);

  check('空输入 / 坏输入不炸',
    sanitizeQuestions(null, { drill: true }).questions.length === 0
    && sanitizeQuestions([], {}).questions.length === 0
    && sanitizeQuestions([null, 0, 'x'], { drill: true }).questions.length === 0);
}

/* ---------- isIncompleteQuestion ---------- */
{
  check('题干空 / 答案空都算不完整',
    isIncompleteQuestion({ question: '', answer: 'a' })
    && isIncompleteQuestion({ question: 'q', answer: '' })
    && isIncompleteQuestion(null));
  check('题干与答案都有就算完整', isIncompleteQuestion({ question: 'q', answer: 'a' }) === false);
}

/* ---------- sanitizeGrades：批改结果的形状清洗 ---------- */
{
  const g = (index, verdict, comment = 'c', better = 'b') => ({ index, verdict, comment, better });
  const out = sanitizeGrades({ grades: [
    g(0, 'right'), g(1, '基本正确但有点小问题'), g(1, 'wrong'),   // 重复题号：只留第一条
    g(9, 'right'),                                              // 越界：丢掉
    g(-1, 'right'),                                             // 负数：丢掉
    g('2', 'close'),                                            // 字符串题号：认
    g(3, 'wrong', 'x'.repeat(2000)),                            // 超长点评：截断
    null, 'nope',
  ] }, 4);
  check('批改：只保留合法题号（越界/负数/重复都丢掉，其余按题号排序）', out.length === 4 && out.map((x) => x.index).join(',') === '0,1,2,3', JSON.stringify(out.map((x) => x.index)));
  check('批改：字符串题号能认', out.some((x) => x.index === 2));
  check('批改：verdict 只留三档（模型写成一句话时退回 close）', out.find((x) => x.index === 1).verdict === 'close');
  check('批改：点评截断，不把上万字灌进界面', out.find((x) => x.index === 3).comment.length === 800);
  check('批改：坏输入不炸', sanitizeGrades(null, 3).length === 0 && sanitizeGrades({ grades: [] }, 0).length === 0);
  check('批改：不漏判时按题号排序', sanitizeGrades({ grades: [g(2, 'right'), g(0, 'wrong')] }, 3).map((x) => x.index).join(',') === '0,2');
}

const fail = results.filter((r) => !r.ok).length;
console.log(`\n${'='.repeat(62)}`);
console.log(fail ? `❌ ${fail}/${results.length} 项失败` : `✅ 全部 ${results.length} 项通过`);
process.exit(fail ? 1 : 0);
