/**
 * 收藏知识点自测题：
 * - favoritesToQuizPoints()：把收藏压缩成给大模型的要点清单
 * - buildLocalQuiz()：不调用模型也能出题（离线兜底）
 * - quizToText()：导出/复制纯文本（可含答案）
 */
import { FAV_KIND_LABEL } from './favorites.js';

export function favoritesToQuizPoints(favorites) {
  return (Array.isArray(favorites) ? favorites : []).filter(Boolean).map((x) => {
    const kind = FAV_KIND_LABEL[x.kind] || x.kind || '知识点';
    const cat = x.category && x.category !== kind ? ' / ' + x.category : '';
    const body = x.body ? ' — ' + String(x.body).replace(/\s+/g, ' ').slice(0, 180) : '';
    const extra = x.extra ? '（' + String(x.extra).replace(/\s+/g, ' ').slice(0, 180) + '）' : '';
    return '[' + kind + cat + '] ' + x.title + body + extra;
  });
}

const splitTitle = (t) => String(t || '').split('→').map((s) => s.trim());

function vocabWord(fav) {
  // 收藏标题形如 "spoil  /spɔɪl/"
  return String(fav.title || '').split(/\s{2,}/)[0].trim();
}
function meaningOf(fav) {
  return String(fav.body || '').split('\n')[0].replace(/^[\d.]+\s*/, '').trim();
}
function tipOf(fav) {
  return String(fav.body || '').replace(/^中文点拨：/, '').trim();
}

/** 一个收藏能衍生出的题目（本地兜底用，不依赖模型） */
function localQuestions(fav) {
  const out = [];
  if (fav.kind === 'vocab') {
    const word = vocabWord(fav);
    const meaning = meaningOf(fav);
    if (word && meaning) {
      out.push({
        type: '翻译',
        question: '写出对应的英文单词：' + meaning,
        options: [],
        answer: word,
        explanation: [meaning, fav.extra ? String(fav.extra).replace(/\n/g, '；') : ''].filter(Boolean).join('；'),
        source: word,
      });
      out.push({
        type: '填空',
        question: '用下面这个词的正确形式填空：' + meaning + '（首字母 ' + word[0] + '，共 ' + word.replace(/[^A-Za-z]/g, '').length + ' 个字母）',
        options: [],
        answer: word,
        explanation: meaning,
        source: word,
      });
    }
  } else if (fav.kind === 'idiom') {
    const idiom = String(fav.title || '').trim();
    const ex = /例句：(.+)/.exec(String(fav.extra || ''));
    if (idiom) {
      out.push({
        type: '造句',
        question: '用习语「' + idiom + '」写一个句子' + (tipOf(fav) ? '（场景提示：' + tipOf(fav).slice(0, 40) + '）' : ''),
        options: [],
        answer: (ex && ex[1].trim()) || idiom,
        explanation: tipOf(fav),
        source: idiom,
      });
    }
  } else if (fav.kind === 'expression') {
    const en = String(fav.title || '').trim();
    const cn = tipOf(fav);
    if (en && cn) {
      out.push({
        type: '翻译',
        question: '用更地道的英文表达下面这句话的意思：' + cn.replace(/^[^：]*：/, '').slice(0, 80),
        options: [],
        answer: en,
        explanation: cn,
        source: en,
      });
    }
  } else {
    const [from, to] = splitTitle(fav.title);
    if (from && to) {
      out.push({
        type: '改错',
        question: '下面这个表达有问题，请改正：' + from,
        options: [],
        answer: to,
        explanation: String(fav.body || ''),
        source: from + ' → ' + to,
      });
      out.push({
        type: '填空',
        question: '把「' + from + '」换成更合适的表达：________（提示：' + (fav.category || '搭配') + '）',
        options: [],
        answer: to,
        explanation: String(fav.body || ''),
        source: to,
      });
    }
  }
  return out;
}

/** 离线兜底：只靠收藏内容出题 */
export function buildLocalQuiz(favorites, count = 10) {
  const list = (Array.isArray(favorites) ? favorites : []).filter(Boolean);
  const pool = [];
  for (const fav of list) pool.push(...localQuestions(fav));
  const n = Math.max(1, Math.min(50, Number(count) || 10));
  const questions = [];
  for (let i = 0; i < n && pool.length; i += 1) questions.push(pool[i % pool.length]);
  return {
    title: '收藏知识点自测（' + questions.length + ' 题 · 本地生成）',
    local: true,
    count: questions.length,
    questions,
  };
}

export function quizToText(quiz, { withAnswers = true } = {}) {
  const qs = (quiz && Array.isArray(quiz.questions)) ? quiz.questions : [];
  const head = (quiz && quiz.title) || '收藏知识点自测';
  const lines = [head, '共 ' + qs.length + ' 题', ''];
  qs.forEach((q, i) => {
    lines.push((i + 1) + '. [' + (q.type || '问答') + '] ' + q.question);
    if (Array.isArray(q.options) && q.options.length) q.options.forEach((o) => lines.push('   ' + o));
    if (withAnswers) {
      lines.push('   答案：' + (q.answer || ''));
      if (q.explanation) lines.push('   解析：' + q.explanation);
      if (q.source) lines.push('   考点：' + q.source);
    }
  });
  return lines.join('\n');
}

export { localQuestions };
