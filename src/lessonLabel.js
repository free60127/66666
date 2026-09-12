/**
 * 课次标签：「Lesson 18 · He often does this!」。
 * 单独成文件的原因：选课（useLessons）、编辑区、自建课文三处都要拼这个标签，
 * 之前定义在 App 里，hook 拆出去后没地方放。
 */
export function lessonLabel(lesson) {
  return lesson ? `Lesson ${lesson.lesson} · ${lesson.title_en || lesson.title_cn}` : '';
}
