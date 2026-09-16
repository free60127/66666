/**
 * 课次标签：「Lesson 18 · He often does this!」。
 * 单独成文件的原因：选课（useLessons）、编辑区、自建课文三处都要拼这个标签，
 * 之前定义在 App 里，hook 拆出去后没地方放。
 */
export function lessonLabel(lesson) {
  return lesson ? `Lesson ${lesson.lesson} · ${lesson.title_en || lesson.title_cn}` : '';
}

/**
 * 课 → lessonKey。**全项目只有这一处**。
 *
 * 为什么必须共享：这个 key 决定了「进度归属」「历史归属」「同一课两次练习的对比」，
 * 错误训练还要靠它把错题对回具体某一课。侧栏原来在自己文件里写了一份同样的逻辑 ——
 * 两份只要有一处漂移（比如自建库用 lid 还是序号），错题就会归错课，而且不会报错。
 * @param {object} l 课时对象（内置：{book, lesson}；自建：{lid, lesson}）
 * @param {object} [activeLib] 当前自建库（有则用 lid）
 */
export function lessonKeyOf(l, activeLib) {
  if (!l) return '';
  if (activeLib) return `lesson:my-${activeLib.id}-${l.lid || l.lesson}`;
  return `lesson:${l.book}-${l.lesson}`;
}
