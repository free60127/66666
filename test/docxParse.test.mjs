/**
 * docxParse 单测：DOCX 文本解析（多英文段 / 标记词角色 / 中文归并）与相似度判定。
 * 对应的线上问题：导入「中文 + 参考译文」的文档时，初稿和原文被填成同一段，批改失去意义。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseDocxText, textSimilarity, REFERENCE_SIM_THRESHOLD } from '../src/docxParse.js';

test('标准三段式（无标记）：中文 1 段 + 英文 1 段', () => {
  const r = parseDocxText('24年12月（第1套）\n中国政府十分重视环境保护。\nThe Chinese government places great emphasis on environmental protection.');
  assert.equal(r.title, '24年12月（第1套）');
  assert.equal(r.chinese, '中国政府十分重视环境保护。');
  assert.equal(r.blocks.length, 1);
  assert.ok(r.blocks[0].text.startsWith('The Chinese government'));
  assert.equal(r.blocks[0].label, '');
});

test('带标记的完整三段式：英文段自动获得角色标签', () => {
  const r = parseDocxText('Lesson 1\n中文\n上星期我去看戏。\n原文\nLast week I went to the theatre.\n初稿\nLast week I go to the theatre.');
  assert.equal(r.chinese, '上星期我去看戏。');
  assert.equal(r.blocks.length, 2);
  assert.equal(r.blocks[0].label, '原文');
  assert.equal(r.blocks[1].label, '初稿');
  assert.ok(r.blocks[1].text.includes('I go to the theatre'));
});

test('两段英文无标记：切成两个块（角色由用户指定）', () => {
  const r = parseDocxText('Title\n中文内容。\nLast week I went to the theatre with my friends.\nThe play was very interesting and I enjoyed it a lot.');
  assert.equal(r.chinese, '中文内容。');
  assert.equal(r.blocks.length, 2);
  assert.ok(r.blocks[0].text.includes('went to the theatre'));
  assert.ok(r.blocks[1].text.includes('The play was very interesting'));
});

test('中文出现在英文之后：仍归入中文，不混进英文段', () => {
  const r = parseDocxText('Title\nLast week I went to the theatre.\n上星期我去看戏。');
  assert.equal(r.chinese, '上星期我去看戏。');
  assert.equal(r.blocks.length, 1);
});

test('纯英文文档：中文为空，英文段保留（由上层按方向决定角色）', () => {
  const r = parseDocxText('Title\nOnly english content here.');
  assert.equal(r.chinese, '');
  assert.equal(r.blocks.length, 1);
});

test('textSimilarity：相同文本 = 1，高度相似超过阈值，无关文本低于阈值', () => {
  const ref = 'The Chinese government places great emphasis on environmental protection. In recent years, China has made remarkable progress in reducing air, water, and soil pollution.';
  const draftSame = ref.replace(/\./g, '. ');
  const draftDiff = 'I like apples and bananas very much because they are delicious and healthy fruits for everyone.';
  assert.equal(textSimilarity(ref, ref), 1);
  assert.ok(textSimilarity(ref, draftSame) > REFERENCE_SIM_THRESHOLD);
  assert.ok(textSimilarity(ref, draftDiff) < 0.3);
});
