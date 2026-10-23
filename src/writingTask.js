/** Local task routing, shared with the existing AI guide request. No model call is needed. */
export const WRITING_TASK_TYPES = { essay: '议论 / 观点作文', letter: '书信 / 邮件', chart: '图表 / 图画作文', material: '材料作文' };
export function writingContext(value) {
  if (!value || typeof value !== 'object') return null;
  const result = {};
  for (const key of ['id', 'draftKey', 'sourceTopicKey', 'parentJobId', 'rootJobId', 'taskType', 'exam', 'label', 'zh']) {
    if (typeof value[key] === 'string') result[key] = value[key].slice(0, key === 'zh' ? 80 : 160);
  }
  // Store only a small bundled-asset reference, never an uploaded image or data URL.
  if (typeof value.image === 'string' && /^\/writing\/figs\/[\w.-]+$/.test(value.image) && value.image.length <= 160) result.image = value.image;
  if (Number.isFinite(Number(value.words)) && Number(value.words) > 0) result.words = Math.min(2000, Number(value.words));
  return result;
}
export function writingTaskType(topic) {
  if (Object.hasOwn(WRITING_TASK_TYPES, topic?.taskType)) return topic.taskType;
  const text = (topic?.qtype || '') + ' ' + (topic?.question || '');
  if (/\b(?:letter|e-?mail|notice|memo)\b|书信|邮件|应用文|通知/i.test(text)) return 'letter';
  if (topic?.material || topic?.excerpt || /\bexcerpts?\b|材料作文/i.test(text)) return 'material';
  if (topic?.image || topic?.imageDesc || /\b(?:chart|graph|table|diagram|picture)\b|图表|图画/i.test(text)) return 'chart';
  return 'essay';
}

export function questionWordTarget(question) {
  const text = String(question || '');
  const range = text.match(/\b(\d{2,4})\s*[-–—~～]\s*(\d{2,4})\s*words?\b/i);
  if (range) return Math.round((Number(range[1]) + Number(range[2])) / 2);
  const single = text.match(/\b(?:about|approximately|around|at least|no less than|minimum(?: of)?|within|no more than)\s+(\d{2,4})\s*words?\b/i)
    || text.match(/\b(\d{2,4})\s*words?\b/i);
  return single ? Math.min(2000, Number(single[1])) : null;
}

const step = (key, label, ratio, tip) => ({ key, label, ratio, tip });
export function writingSteps(topic) {
  switch (writingTaskType(topic)) {
    case 'letter': return [
      step('intro', '称呼与来意', .2, '确认收信人和语气，用简短开头说明写信目的。'),
      step('body1', '事项说明', .4, '逐项写清题目要求的信息，例如时间、地点、安排或理由。'),
      step('body2', '请求与回应', .25, '说明希望对方采取的行动或需要回应的问题，避免遗漏任务点。'),
      step('concl', '结束语与落款', .15, '礼貌收尾，按题目要求署名，不使用题目禁止的真实姓名。'),
    ];
    case 'chart': return [
      step('intro', '介绍图示', .15, '交代图表主题、时间与单位；图画题先描述核心画面。'),
      step('body1', '总体特征', .25, '概括最显著的趋势或对比，不把每个细节都塞进概述。'),
      step('body2', '关键细节', .4, '用图中真实数据或画面支撑概述，核对最高、最低与变化。'),
      step('concl', /comment|opinion|interpret|view|评论|看法/i.test(topic?.question || '') ? '解读与评论' : '补充对比', .2,
        /comment|opinion|interpret|view|评论|看法/i.test(topic?.question || '')
          ? '按题目要求解释现象并给出评论，区分图中事实与个人推断。'
          : '补充另一组重要对比；客观图表题不添加题目未要求的原因或个人意见。'),
    ];
    case 'material': return [
      step('intro', '概括材料', .25, '分别辨认各篇材料的观点，准确概括共同点或分歧，避免逐句照抄。'),
      step('body1', '回应与立场', .2, '回应材料中的核心问题，明确自己的观点。'),
      step('body2', '论证与例证', .4, '结合材料展开自己的分析，补充理由或例子，不只重复材料。'),
      step('concl', '总结回应', .15, '总结论证并回应材料提出的问题，检查任务点是否完整。'),
    ];
    default: return [
      step('intro', '引言', .15, '点明主题并按题目要求表明立场。'),
      step('body1', '主体段 1', .3, '展开第一个任务点，用论据或例子支撑。'),
      step('body2', '主体段 2', .3, '展开其余任务点，注意回应不同观点和段落衔接。'),
      step('concl', '结论', .25, '总结全文，回应题目要求，不引入新的论据。'),
    ];
  }
}
