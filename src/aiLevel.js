/**
 * 材料 → AI 难度等级的推断。
 *
 * 为什么单独成文件：课文模式与写作模式都要「选了什么材料，难度就跟着对齐」，
 * 而等级枚举（小初/高考英语/四六级/考研/专四/专八）在 App 里定义，教材册号在
 * server/corpus.mjs、写作题库 exam 在 writingExamBank.js —— 三边都要这个映射，
 * 放任何一边都会造成另一边反向依赖。
 *
 * 推断不了的一律返回 null（自建课文库、精选自编/自定义/班级作业题）：
 * 调用方据此**显示**难度下拉让用户自己选 —— 控件只在推断不了的时候出现。
 */

/** 内置真题册（server/corpus.mjs BOOK_META）→ 等级。book 10 按课文 section 细分，不走这张表 */
const BOOK_LEVEL = {
  5: '四六级',   // 四级
  6: '四六级',   // 六级
  7: '考研/专四', // 英语（一）
  8: '考研/专四', // 英语（二）
  9: '专八',
  11: '考研/专四', // catti 真题
};

/** 回译课文（book 10）的 section → 等级。取值必须与语料 JSON 的 section 逐字一致 */
const SECTION_LEVEL = {
  '小初英语': '小初',
  '高中英语': '高考英语',
  '四六级': '四六级',
  '考研英语': '考研/专四',
  '专四': '考研/专四',
  '专八': '专八',
  'catti二笔/三笔': '考研/专四',
};

/**
 * 当前加载的课文 → 等级。null = 推断不了（自建库 / 无 section 的未知册）。
 * @param {object} lesson matchedLesson（内置：{book, section?, ...}；自建：{book:'my',...}）
 */
export function lessonAiLevel(lesson) {
  if (!lesson || lesson.book === 'my') return null;
  if (lesson.section && SECTION_LEVEL[lesson.section]) return SECTION_LEVEL[lesson.section];
  return BOOK_LEVEL[lesson.book] || null;
}

/**
 * 写作题目 → 等级。按题库 exam 来源映射；精选自编/自定义/班级作业返回 null。
 * @param {object} topic WritingStudio 的当前题目（{exam, ...}）
 */
export function writingTopicAiLevel(topic) {
  switch (topic?.exam) {
    case 'cet4':
    case 'cet6':
      return '四六级';
    case 'kaoyan1':
    case 'kaoyan2':
    case 'tem4':
      return '考研/专四';
    case 'tem8':
      return '专八';
    default:
      return null;
  }
}

/**
 * 难度下拉是否显示。推断得出等级 → 隐藏（控件只在用户需要做选择时出现）；
 * 唯一例外：课文加载窗口里 matchedLesson 暂为 null，若上一次还是推断态就维持隐藏，避免下拉闪一下又消失。
 */
export function levelSelectVisible({ inferredLevel, hadInferredLevel, mode, writingOpen, lessonLoading }) {
  if (inferredLevel) return false;
  if (mode === 'lesson' && !writingOpen && lessonLoading && hadInferredLevel) return false;
  return true;
}
