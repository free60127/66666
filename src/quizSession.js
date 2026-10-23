/** Keep at most three local quizzes. Only completion scores enter the existing cloud progress map. */
export const QUIZ_CURRENT_KEY = 'bt-quiz-current';
export const QUIZ_SESSION_PREFIX = 'bt-quiz-session:';
export function quizSessionId(quiz) {
  if (/^[\w-]{1,60}$/.test(quiz?._sessionId || '')) return quiz._sessionId;
  let hash = 2166136261;
  for (const char of JSON.stringify(quiz?.questions || [])) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  return 'legacy-' + (hash >>> 0).toString(36);
}
export function loadQuizSession(id) {
  try {
    const key = id || localStorage.getItem(QUIZ_CURRENT_KEY);
    if (!key || !/^[\w-]{1,60}$/.test(key)) return null;
    const row = JSON.parse(localStorage.getItem(QUIZ_SESSION_PREFIX + key) || 'null');
    if (!Array.isArray(row?.quiz?.questions) || !row.quiz.questions.length || row.quiz.questions.length > 60) return null;
    if (row.quiz.questions.some((q) => !q || typeof q.question !== 'string' || typeof q.answer !== 'string')) return null;
    const answers = {}, verdicts = {};
    row.quiz.questions.forEach((_, index) => {
      if (typeof row.answers?.[index] === 'string') answers[index] = row.answers[index].slice(0, 20000);
      const v = row.verdicts?.[index];
      if (v && ['right', 'wrong', 'close', 'pending'].includes(v.status)) verdicts[index] = v;
    });
    return { ...row, answers, verdicts };
  } catch { return null; }
}
export function saveQuizSession(quiz, answers = {}, verdicts = {}, reported = '', activate = false, baseline = null) {
  try {
    const id = quizSessionId(quiz);
    const existing = loadQuizSession(id);
    if (baseline && existing) {
      // Idle tabs do not erase newer answers; edits to different questions can be combined.
      const mergedAnswers = { ...existing.answers }, mergedVerdicts = { ...existing.verdicts };
      for (let i = 0; i < quiz.questions.length; i++) {
        const old = JSON.stringify([baseline.answers?.[i], baseline.verdicts?.[i]]);
        const incoming = JSON.stringify([answers[i], verdicts[i]]);
        if (incoming === old) continue;
        const remote = JSON.stringify([existing.answers[i], existing.verdicts[i]]);
        if (remote !== old && remote !== incoming) return false;
        if (answers[i] === undefined) delete mergedAnswers[i]; else mergedAnswers[i] = answers[i];
        if (verdicts[i] === undefined) delete mergedVerdicts[i]; else mergedVerdicts[i] = verdicts[i];
      }
      answers = mergedAnswers; verdicts = mergedVerdicts;
    }
    const raw = JSON.stringify({ quiz, answers, verdicts, reported, savedAt: Date.now() });
    if (raw.length > 300000 || !quiz?.questions?.length || quiz.questions.length > 60) return false;
    localStorage.setItem(QUIZ_SESSION_PREFIX + id, raw);
    if (activate || !localStorage.getItem(QUIZ_CURRENT_KEY)) localStorage.setItem(QUIZ_CURRENT_KEY, id);
    const keys = Object.keys(localStorage).filter((key) => key.startsWith(QUIZ_SESSION_PREFIX) && key !== QUIZ_SESSION_PREFIX + id)
      .sort((a, b) => (loadQuizSession(b.slice(QUIZ_SESSION_PREFIX.length))?.savedAt || 0) - (loadQuizSession(a.slice(QUIZ_SESSION_PREFIX.length))?.savedAt || 0));
    keys.slice(2).forEach((key) => localStorage.removeItem(key));
    return true;
  } catch { return false; }
}
export function newQuizSession(quiz) {
  const data = { ...quiz, _sessionId: globalThis.crypto.randomUUID() };
  saveQuizSession(data, {}, {}, '', true);
  return data;
}
