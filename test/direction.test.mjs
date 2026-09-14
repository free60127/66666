/**
 * 练习方向（汉译英 / 英译汉）的纯逻辑测试。
 *
 * 为什么值得单测：两个方向**共用同一套结果字段**（chinese/draft/ai/original），
 * 只靠"角色"区分（见 src/direction.js）。一旦某个方向的文案或槽位映射写错，
 * 表现是"英译汉的界面上写着中文提示""初稿栏提示填英文"这类错位 ——
 * 功能能跑通、不报错，只有人眼才看得出来。所以把映射关系钉在这里。
 *
 * 跑法：node test/direction.test.mjs
 */
import {
  DEFAULT_DIRECTION, DIRECTIONS, DIRECTION_META, directionMeta, directionText,
  isDirection, normalizeDirection, slotLanguage,
} from '../src/direction.js';

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
};

console.log('=== 练习方向测试 ===\n');

/* ---------- 1. 归一化：脏值一律回落默认，不能让界面拿到 undefined ---------- */
{
  check('两个方向都在注册表里', DIRECTIONS.length === 2 && DIRECTIONS.includes('cn2en') && DIRECTIONS.includes('en2cn'), DIRECTIONS.join(','));
  check('默认方向是汉译英（老数据没有这个字段时的行为）', DEFAULT_DIRECTION === 'cn2en');
  check('合法值原样返回', normalizeDirection('en2cn') === 'en2cn');
  for (const bad of [undefined, null, '', 'EN2CN', 'en->cn', 0, {}, [], 'cn2en ']) {
    check(`脏值 ${JSON.stringify(bad)} 回落默认方向`, normalizeDirection(bad) === DEFAULT_DIRECTION);
  }
  check('isDirection 只认白名单', isDirection('cn2en') && isDirection('en2cn') && !isDirection('nope'));
}

/* ---------- 2. 槽位 → 语言：OCR 靠它选"识别中文还是英文" ---------- */
{
  // 汉译英：源栏中文、初稿英文、标准答案（课文原文）英文
  check('汉译英：源栏识别中文', slotLanguage('cn2en', 'chinese') === 'chinese');
  check('汉译英：初稿栏识别英文', slotLanguage('cn2en', 'english') === 'english');
  check('汉译英：标准答案栏识别英文', slotLanguage('cn2en', 'original') === 'english');
  // 英译汉：源栏是英文原文、初稿与参考译文是中文
  check('英译汉：源栏识别英文', slotLanguage('en2cn', 'chinese') === 'english');
  check('英译汉：初稿栏识别中文', slotLanguage('en2cn', 'english') === 'chinese');
  check('英译汉：参考译文栏识别中文', slotLanguage('en2cn', 'original') === 'chinese');
  check('方向是脏值时按默认方向取语言', slotLanguage('乱写', 'chinese') === 'chinese');
}

/* ---------- 3. 文案完整性：两个方向的字段必须一一对应 ---------- */
{
  const keys = Object.keys(DIRECTION_META.cn2en.text).sort();
  check('两个方向的文案键完全一致（少一个就会渲染出 undefined）',
    JSON.stringify(Object.keys(DIRECTION_META.en2cn.text).sort()) === JSON.stringify(keys),
    `cn2en=${keys.length} 项`);
  const empty = [];
  for (const d of DIRECTIONS) {
    for (const [k, v] of Object.entries(DIRECTION_META[d].text)) {
      const bad = v == null || (typeof v === 'string' && !v.trim())
        || (Array.isArray(v) && v.some((x) => !String(x).trim()))
        || (typeof v === 'object' && !Array.isArray(v) && Object.values(v).some((x) => !String(x).trim()));
      if (bad) empty.push(`${d}.${k}`);
    }
  }
  check('没有空文案', empty.length === 0, empty.join(', '));
  check('selection 页需要的字段都在（流程/示例/说明）',
    DIRECTIONS.every((d) => DIRECTION_META[d].flow.length >= 3 && DIRECTION_META[d].sampleFrom && DIRECTION_META[d].sampleTo && DIRECTION_META[d].blurb));
}

/* ---------- 4. 文案方向不能写反（本次最容易犯的错） ---------- */
{
  const cn = directionText('cn2en');
  const en = directionText('en2cn');
  check('汉译英：源栏叫「中文提示」', cn.sourceTitle === '中文提示', cn.sourceTitle);
  check('英译汉：源栏叫「英文原文」', en.sourceTitle === '英文原文', en.sourceTitle);
  check('汉译英：初稿栏是英文初稿', /英文/.test(cn.draftTitle), cn.draftTitle);
  check('英译汉：初稿栏是中文翻译', /中文/.test(en.draftTitle), en.draftTitle);
  check('汉译英：标准答案栏是英文原文', /英文/.test(cn.referenceTitle), cn.referenceTitle);
  check('英译汉：标准答案栏是参考译文', /参考译文/.test(en.referenceTitle), en.referenceTitle);
  check('英译汉的结果页眉写的是翻译而不是回译', /翻译/.test(en.eyebrow) && !/回译/.test(en.eyebrow), en.eyebrow);
  check('汉译英的结果页眉写的仍是回译', /回译/.test(cn.eyebrow), cn.eyebrow);
  check('两个方向的生成按钮文案不同（用户一眼看出模式）', cn.generateBtn !== en.generateBtn, `${cn.generateBtn} / ${en.generateBtn}`);
  check('英译汉的逐句标题不再写"三版本对比"', !/三版本/.test(en.sentencesTitle), en.sentencesTitle);
  check('copyHeaders 四栏齐全且两个方向各自成对',
    ['source', 'draft', 'ai', 'reference'].every((k) => cn.copyHeaders[k] && en.copyHeaders[k]));
  check('英译汉的复制表头是"我的译稿"而不是"原稿"', en.copyHeaders.draft !== cn.copyHeaders.draft, `${cn.copyHeaders.draft} / ${en.copyHeaders.draft}`);
}

/* ---------- 5. directionMeta 提供选择页要用的展示信息 ---------- */
{
  check('directionMeta 也接受脏值', directionMeta('xxx').id === DEFAULT_DIRECTION);
  check('两个方向各有简称与标语（选择页卡片用）',
    DIRECTION_META.cn2en.short === '汉 → 英' && DIRECTION_META.en2cn.short === '英 → 汉');
}

console.log('\n' + '='.repeat(62));
const failed = results.filter((r) => !r.ok);
console.log(failed.length ? `❌ ${failed.length}/${results.length} 项失败` : `✅ 全部 ${results.length} 项通过`);
process.exit(failed.length ? 1 : 0);
