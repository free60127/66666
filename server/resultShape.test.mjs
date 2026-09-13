/**
 * 服务端结果清洗（resultShape）单测。
 *
 * 起因：用户实测反馈结果里出现「went → went」这种原样重复的"改写对" ——
 * 学生本来就写对了，模型为了凑数硬造条目。这类噪音必须在**入库前**丢掉，
 * 否则会进历史、进分享链接、被同步到别的设备。
 *
 * 另一个重点是**不能过度过滤**：大小写（hello→Hello）、标点（went→went.）、
 * 冠词等差异都是真实可批改的点，误删会让用户"明明有错却不提示"。
 */
import { sameExpression, isNoopFinding, cleanFindings, sanitizeSentences, sanitizeOverall } from './resultShape.mjs';

let pass = 0;
let fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) { pass += 1; console.log('PASS  ' + name + (detail ? '  — ' + detail : '')); }
  else { fail += 1; console.log('FAIL  ' + name + (detail ? '  — ' + detail : '')); }
};

/* ---------- sameExpression：只归一化空白 ---------- */
check('相同字符串判为相同', sameExpression('went', 'went'));
check('只差首尾空格判为相同', sameExpression('  went  ', 'went'));
check('只差内部连续空白判为相同（模型偶尔多打空格）', sameExpression('went  to\tthe', 'went to the'));
check('大小写差异**不算**相同（Hello 是真实的大小写批改点）', !sameExpression('hello', 'Hello'));
check('句末标点差异**不算**相同（标点是真实批改点）', !sameExpression('went to the theatre', 'went to the theatre.'));
check('加冠词不算相同', !sameExpression('went to theatre', 'went to the theatre'));
check('空串不与空串判为相同（缺内容的条目另由 isNoopFinding 处理）', !sameExpression('', ''));
check('数字/类型混入不抛异常', sameExpression(null, undefined) === false);

/* ---------- isNoopFinding：用户反馈的那条 ---------- */
const wentCase = { category: '时态', level: 'study', from: 'went', to: 'went', explanation: '一般过去时 went 正确…' };
check('★ went → went 被判为噪音', isNoopFinding(wentCase) === true);
check('缺 to 的条目是噪音', isNoopFinding({ from: 'went' }) === true);
check('缺 from 的条目是噪音', isNoopFinding({ to: 'went' }) === true);
check('空 from/to 是噪音', isNoopFinding({ from: '  ', to: '  ' }) === true);
check('真实改写不是噪音', isNoopFinding({ from: 'search my bag', to: 'search for my bag' }) === false);
check('普通说法 → 高级说法不是噪音', isNoopFinding({ from: 'stopped', to: 'rumbled to a halt' }) === false);

/* ---------- cleanFindings：过滤 + 去重 + 类型规整 ---------- */
{
  const { list, dropped } = cleanFindings([
    wentCase,                                                        // 噪音：原样重复
    { category: '词义', from: 'a little village bar', to: 'a village pub', level: 'improve' }, // 有效
    { category: '词义', from: 'a little village bar', to: 'a village pub', level: 'improve' }, // 重复
    { category: '语法', from: 'Just I was', to: '', level: 'error' }, // 噪音：缺 to
    { category: '搭配', from: 'search my bag', to: 'search for my bag', level: 'error', dimensions: ['固定搭配', 42, null] },
  ]);
  check('丢掉 2 条噪音 + 1 条重复（共 3）', dropped === 3, 'dropped=' + dropped);
  check('保留 2 条有效条目', list.length === 2, 'len=' + list.length);
  check('dimensions 只留字符串', JSON.stringify(list[1].dimensions) === JSON.stringify(['固定搭配']));
  check('synonyms 缺省为空数组', Array.isArray(list[0].synonyms) && list[0].synonyms.length === 0);
  check('有效条目内容未被改动', list[1].to === 'search for my bag' && list[1].level === 'error');
}

check('cleanFindings 对非数组输入返回空列表', cleanFindings(null).list.length === 0);
check('cleanFindings 丢掉 null / 字符串条目', cleanFindings([null, 'x', 42, { from: 'a', to: 'b' }]).list.length === 1);

/* ---------- sanitizeSentences：整段结果的清洗 ---------- */
{
  const { list, dropped } = sanitizeSentences([
    { cn: '上星期我去看戏。', findings: [wentCase, { from: 'went to see a play', to: 'went to the theatre', category: '地道程度' }] },
    { cn: '这位作家刚刚到达。', findings: [{ from: 'arrived', to: 'arrived' }] },
    { cn: '没有 findings 的句子', findings: [] },
    { cn: 'findings 字段缺失' },
    null,
    'oops',
  ]);
  check('脏句子被丢掉（只剩 4 条对象）', list.length === 4, 'len=' + list.length);
  check('逐句过滤：第一句保留 1 条（went→went 被丢）', list[0].findings.length === 1 && list[0].findings[0].to === 'went to the theatre');
  check('第二句 findings 被清空', list[1].findings.length === 0);
  check('汇总 dropped = 2', dropped === 2, 'dropped=' + dropped);
  check('句子其它字段保留', list[0].cn === '上星期我去看戏。');
}

/* ---------- sanitizeOverall 不受影响 ---------- */
{
  const o = sanitizeOverall({ score: 72, scoreBreakdown: [{ label: '词汇准确', score: 13, max: 20 }, null, 'x'] });
  check('scoreBreakdown 只留对象', o.scoreBreakdown.length === 1);
  check('其余字段原样保留', o.score === 72);
  check('非对象输入回退为空对象', JSON.stringify(sanitizeOverall(null)) === JSON.stringify({ scoreBreakdown: [] }));
}

console.log('\n' + '='.repeat(58));
console.log(fail ? `❌ ${fail} / ${pass + fail} 项失败` : `✅ 全部 ${pass} 项通过`);
process.exit(fail ? 1 : 0);
