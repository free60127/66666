/**
 * 练习方向：汉译英（回译）/ 英译汉（翻译）。
 *
 * ## 为什么两个方向共用同一套数据结构
 *
 * 结果里还是那四个槽（`chinese` / `draft` / `ai` / `original`），只是每个槽的**角色**
 * 随方向解释：
 *
 * | 槽位       | 汉译英 cn2en          | 英译汉 en2cn          |
 * | ---------- | --------------------- | --------------------- |
 * | `chinese`  | 中文提示（题目）      | 英文原文（题目）      |
 * | `draft`    | 学生的英文初稿        | 学生的中文初稿        |
 * | `ai`       | AI 修正版（英文）     | AI 润色译文（中文）   |
 * | `original` | 课文原文（英文答案）  | 参考译文（中文答案）  |
 * | `sentences[].cn/draft/ai/original` | 逐句的四栏，同上 | 同上 |
 *
 * 这么做是为了让**历史记录 / 收藏夹 / 云同步 / 分享链接 / 打印 / 自测题 / 同课对比**
 * 这些依赖结果结构的下游**一处都不用改** —— 它们只认字段名，不关心字段的角色。
 * 代价是字段名读起来"名不副实"（英译汉时 `chinese` 里装的是英文），
 * 所以**所有跟方向有关的文案都收敛在本文件里**，界面上不会出现错位的标签。
 *
 * ## 新增一个方向要改什么
 *
 * 1. 这里加一条 meta（名字 + 全部文案 + 选择页的说明）；
 * 2. server/prompt.mjs 加该方向的 system prompt 与 user message；
 * 3. server/index.mjs 的 DIRECTION_PROMPT 表里登记。
 * 界面（编辑器 / 结果页 / 侧栏 / OCR）全部读本文件，不需要再改。
 */

export const DIRECTION_KEY = 'bt-direction';
export const DIRECTIONS = ['cn2en', 'en2cn'];
export const DEFAULT_DIRECTION = 'cn2en';

export const isDirection = (v) => DIRECTIONS.includes(v);
/** 脏值一律回落默认方向：老数据没有这个字段时也要能正常渲染 */
export const normalizeDirection = (v) => (isDirection(v) ? v : DEFAULT_DIRECTION);

/** 方向影响"哪一栏是哪种语言"——OCR 与选课映射都要用 */
export const slotLanguage = (direction, side) => {
  const dir = normalizeDirection(direction);
  if (dir === 'en2cn') return side === 'chinese' ? 'english' : 'chinese'; // 源栏英文，初稿/参考译文中文
  return side === 'chinese' ? 'chinese' : 'english';
};

export const DIRECTION_META = {
  cn2en: {
    id: 'cn2en',
    name: '汉译英',
    short: '汉 → 英',
    tagline: '看中文写英文',
    blurb: '给一段中文，你把它译成英文；AI 逐句批改并与课文原文对照。',
    flow: ['中文提示', '你的英文初稿', 'AI 修正版', '原文对照'],
    sampleFrom: '上星期我去看戏。',
    sampleTo: 'Last week I went to the theatre.',
    sampleFromLang: '中',
    sampleToLang: 'EN',
    text: {
      freeTitle: '自由回译训练',
      eyebrow: 'BACK-TRANSLATE TRAINING · 回译训练作业',
      generateBtn: '生成完整回译训练作业',
      generateHint: '生成顺序：标题 → 中文提示 → 英文初稿 → AI 修正版 → 原文 → 逐句解析',
      guideSteps: [
        '左边选一节课，或点「上传 DOCX 作业」导入自己的作业',
        '在「你的英文初稿」里写下你的回译',
        '点下面的「生成完整回译训练作业」，等 1-2 分钟出结果',
      ],

      sourceTitle: '中文提示',
      sourceOcrTitle: '调用摄像头拍照并识别中文',
      sourceOcrDone: '已填入中文提示',
      sourcePlaceholder: '上传 DOCX 后自动填入；也可拍照、导入图片，或把图片直接拖到这里识别（印刷体 / 手写体均可）',
      sourceNote: '支持：拍照 / 导入图片 / 电脑端拖入图片；识别后可先核对再生成',

      draftTitle: '你的英文初稿',
      draftOcrTitle: '调用摄像头拍照并识别英文',
      draftOcrDone: '已追加到英文初稿',
      draftPlaceholder: '上传 DOCX 后自动填入；也可拍照作文纸、导入图片，或把图片直接拖到这里识别英文（印刷体 / 手写体均可）',
      draftNote: '支持：拍照 / 导入图片 / 电脑端拖入图片；手写体建议把「识别模式」切到「手写体优先」',

      referenceTitle: '英文原文（标准答案）',
      referenceOcrTitle: '调用摄像头拍照并识别英文原文',
      referenceOcrDone: '已追加到英文原文',
      referencePlaceholder: '把这一课的英文原文粘贴到这里（课文原文 / 你要对标的范文都行）；也可以拍照或导入图片识别。留空则使用内置语料或 AI 素材自带的原文。',
      referenceNote: '支持：拍照 / 导入图片 / 电脑端把图片拖进这一栏',
      referenceHint: '填了才能在结果里做「原文对照」',

      refsHint: '中文 / 原稿 / AI 修正版 / 原文',
      sectionSource: '中文',
      sectionDraft: '原稿',
      sectionAi: 'AI 修正版',
      sectionReference: '原文',
      draftMarkNote: '红色标记 = 必须改正的错误（纯润色升级不再标线，可在下方逐句解析里对照学习）',
      emptyReference: '（自由模式：未匹配到课文原文）',
      sentencesTitle: '逐句解析与三版本对比',
      copyHeaders: { source: '中文译文', draft: '原稿', ai: 'AI 修正版', reference: '课文原文' },
    },
  },

  en2cn: {
    id: 'en2cn',
    name: '英译汉',
    short: '英 → 汉',
    tagline: '看英文写中文',
    blurb: '给一段英文，你把它译成中文；AI 逐句批改并与参考译文对照。',
    flow: ['英文原文', '你的中文翻译', 'AI 润色译文', '参考译文对照'],
    sampleFrom: 'Last week I went to the theatre.',
    sampleTo: '上星期我去看戏。',
    sampleFromLang: 'EN',
    sampleToLang: '中',
    text: {
      freeTitle: '自由翻译训练',
      eyebrow: 'TRANSLATION TRAINING · 翻译批改作业',
      generateBtn: '生成完整翻译批改作业',
      generateHint: '生成顺序：标题 → 英文原文 → 中文译稿 → AI 润色译文 → 参考译文 → 逐句解析',
      guideSteps: [
        '左边选一节课（或点「上传 DOCX 作业」导入自己的英文材料）',
        '在「你的中文翻译」里写下你的译文',
        '点下面的「生成完整翻译批改作业」，等 1-2 分钟出结果',
      ],

      sourceTitle: '英文原文',
      sourceOcrTitle: '调用摄像头拍照并识别英文原文',
      sourceOcrDone: '已填入英文原文',
      sourcePlaceholder: '把要翻译的英文粘贴到这里；也可拍照、导入图片，或把图片直接拖到这里识别（印刷体 / 手写体均可）',
      sourceNote: '支持：拍照 / 导入图片 / 电脑端拖入图片；这是本次要翻译的题目',

      draftTitle: '你的中文翻译',
      draftOcrTitle: '调用摄像头拍照并识别中文译稿',
      draftOcrDone: '已追加到中文翻译',
      draftPlaceholder: '在这里写下你的中文译文；手写稿可以拍照或导入图片识别（印刷体 / 手写体均可）',
      draftNote: '支持：拍照 / 导入图片；手写体建议把「识别模式」切到「手写体优先」',

      referenceTitle: '参考译文（标准答案）',
      referenceOcrTitle: '调用摄像头拍照并识别参考译文',
      referenceOcrDone: '已追加到参考译文',
      referencePlaceholder: '把这一篇的参考译文（或你要对标的范文译文）粘贴到这里；也可以拍照或导入图片识别。留空则使用内置语料自带的译文。',
      referenceNote: '支持：拍照 / 导入图片 / 电脑端把图片拖进这一栏',
      referenceHint: '填了才能在结果里做「参考译文对照」',

      refsHint: '英文原文 / 你的译稿 / AI 润色译文 / 参考译文',
      sectionSource: '英文原文',
      sectionDraft: '你的译稿',
      sectionAi: 'AI 润色译文',
      sectionReference: '参考译文',
      draftMarkNote: '红色标记 = 必须修正的译法（措辞与润色建议不再标线，可在下方逐句解析里对照学习）',
      emptyReference: '（自由模式：未填参考译文）',
      sentencesTitle: '逐句解析与译文对比',
      copyHeaders: { source: '英文原文', draft: '我的译稿', ai: 'AI 润色译文', reference: '参考译文' },
    },
  },
};

/** 取某个方向的全部文案（脏值回落默认方向，调用方不用自己兜底） */
export function directionText(direction) {
  return DIRECTION_META[normalizeDirection(direction)].text;
}
export function directionMeta(direction) {
  return DIRECTION_META[normalizeDirection(direction)];
}
