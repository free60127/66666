import assert from 'node:assert/strict';
import { getCorpora, matchLesson, resolveLesson } from './corpus.mjs';

// Isolated process: replace only the in-memory corpus, never files or production data.
const corpora = getCorpora();
const saved = [...corpora];
const item = { book: 5, lesson: 1, title_en: '', title_cn: '测试课文', chinese: '这是一段独立的中文提示。', english: 'An independent English source.' };
try {
  corpora.clear(); corpora.set(5, { lessons: [item] });
  assert.equal(matchLesson({ title: 'A Saturday at the Library', chinese: 'A completely unrelated source.' }).match, null);
  assert.equal(resolveLesson({ title: '测试课文', chinese: 'Unrelated English', direction: 'en2cn' }), null);
  assert.equal(resolveLesson({ title: 'Lesson 1', chinese: '不同内容', book: 5 }), null);
  assert.equal(resolveLesson({ chinese: item.english, direction: 'en2cn' }), item);
  assert.equal(resolveLesson({ chinese: item.chinese }), item);
  assert.equal(resolveLesson({ book: 5, lessonId: 1, chinese: item.english, direction: 'en2cn' }), item);
  corpora.set(6, { lessons: [{ ...item, book: 6 }] });
  assert.equal(resolveLesson({ chinese: item.english, direction: 'en2cn' }), null);
  console.log('PASS corpus: empty titles never match, free tasks require exact source, English matching and explicit selections work, ambiguity stays unselected');
} finally {
  corpora.clear(); for (const [key, value] of saved) corpora.set(key, value);
}
