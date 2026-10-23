import { dueFavorites } from './favorites.js';
import { writingTopicKey, writingSourceKey } from './writing.js';
import { summarizeVerdicts } from './quizGrade.js';

/** Bounded local recommendations, ordered by unfinished work and due review. */
export function learningRecommendations({ drafts = [], translationDrafts = [], history = [], favorites = [], progress = {}, quizSession, readResult = () => null, now = Date.now() }) {
  const cards = [];
  const latest = [...history].sort((a, b) => b.time - a.time);
  for (const draft of drafts) {
    const text = draft.mode === 'guided' ? draft.segs.join('\n\n') : draft.essay;
    if (!text?.trim()) continue;
    const key = writingTopicKey(draft.topic);
    if (draft.savedAt && (progress[key]?.at || 0) >= draft.savedAt) continue;
    const submitted = latest.find((row) => row.lessonKey === key || (row.writingTopic && writingTopicKey(row.writingTopic) === key));
    if (submitted?.status === 'pending' || (submitted && readResult(submitted.jobId)?.draft?.trim() === text.trim())) continue;
    cards.push({ kind: 'writing-draft', title: '继续写作：' + (draft.workTitle || draft.topic.zh || '未命名作文'), reason: '本机还有未完成或修改中的正文。', draft });
    break;
  }
  const translation = translationDrafts.find((draft) => !latest.some((row) => row.lessonKey === draft.key && row.time >= draft.savedAt));
  if (translation) cards.push({ kind: 'translation-draft', title: '继续翻译：' + (translation.title || '未命名草稿'), reason: '接着完成上次保存的翻译。', key: translation.key });
  if (quizSession) {
    const total = quizSession.quiz.questions.length;
    const summary = summarizeVerdicts(quizSession.verdicts, total);
    if (summary.judged < total) cards.push({ kind: 'quiz', title: '继续自测：' + (quizSession.quiz.title || '收藏自测'), reason: '已核对 ' + summary.judged + ' / ' + total + ' 题，作答已在本机保存。' });
  }
  const due = dueFavorites(favorites, now).length;
  if (due) cards.push({ kind: 'review', title: '复习今天到期的 ' + due + ' 张卡片', reason: '先回想，再翻面核对；按掌握情况安排下次复习。' });
  const pending = latest.find((row) => row.status === 'pending');
  if (pending) cards.push({ kind: 'report', jobId: pending.jobId, title: '查看批改进度：' + pending.title, reason: '继续读取已提交的任务，无需重新提交。' });
  const revision = latest.find((row) => {
    const result = readResult(row.jobId);
    return result?.direction === 'writing' && row.status !== 'pending'
      && !latest.some((child) => child.writingTopic?.parentJobId === row.jobId)
      && !drafts.some((draft) => draft.topic.parentJobId === row.jobId)
      && (Number(result.overall?.issues) > 0 || result.sentences?.some((s) => s.findings?.some((f) => f.level !== 'study')));
  });
  if (revision) cards.push({ kind: 'report', jobId: revision.jobId, title: '回看并修改：' + revision.title, reason: '已有报告指出了可改进的地方，先完成这一轮修改。' });
  return cards.slice(0, 5);
}

export function nextWritingTopic(topics, progress, level) {
  const exam = level === '专八' ? ['tem8'] : level === '考研/专四' ? ['english1', 'english2', 'kaoyan1', 'kaoyan2', 'tem4'] : ['cet4', 'cet6'];
  const preferred = topics.filter((topic) => ['小初', '高考英语'].includes(level) ? topic.exam === 'own' && topic.level === '初级' : exam.includes(topic.exam));
  const pool = preferred.length ? preferred : topics;
  return pool.find((topic) => !progress[writingSourceKey(topic)]?.n) || pool[0];
}
