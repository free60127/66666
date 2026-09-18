/**
 * 自测卷的作答与批改状态：答题内容、本地判分、AI 批量批改、AI 不可用时的自评兜底。
 *
 * 为什么单独一个 hook：这块状态有 5 个入口（点选项 / 输入 / 逐题核对 / 底部批改 / 重做）
 * 和一条异步链路（提交→轮询），塞进 QuizSheet 的 JSX 里会让那个纯展示组件变成
 * 两百行的状态机。卷子本身仍然是"传进来就能画"的。
 *
 * 批改分两层（见 src/quizGrade.js）：
 *  1. 本地判：选择/填空/改错点一下立刻出结果，断网也能用；
 *  2. AI 复核：只送**本地拿不准的**（主观题、判成"接近"的、改错判"错"的），
 *     一次批量提交；AI 不可用时退回"对照参考答案自评"，不让用户卡在转圈上。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { getQuizJob, quiz as quizApi } from '../api.js';
import { MAX_GRADE_ITEMS, POLL_QUIZ_MS, TIMEOUT_QUIZ_MS } from '../constants.js';
import { gradingMode, judgeLocally, needsAIGrade, summarizeVerdicts } from '../quizGrade.js';
import { useJobRunner } from './useJobRunner.js';

export function useQuizGrade({ quiz, settings }) {
  const [answers, setAnswers] = useState({});     // 题号 → 作答（选择题存选项字母）
  const [verdicts, setVerdicts] = useState({});   // 题号 → { status, by, expected, comment, better }
  const [tip, setTip] = useState('');
  // 这一批交给 AI 的题号 + 还没有拿到判定的那些（底部据此显示"已判 2/5 题"、题上显示"批改中"）
  const [pendingAI, setPendingAI] = useState([]);
  const [aiTotal, setAiTotal] = useState(0);
  const { busy: aiBusy, elapsed, run } = useJobRunner();

  // 回调里要读最新值，但又不想把它们放进依赖（每次输入都会重建回调）
  const answersRef = useRef(answers);
  answersRef.current = answers;
  const verdictsRef = useRef(verdicts);
  verdictsRef.current = verdicts;

  const qs = useMemo(() => (Array.isArray(quiz && quiz.questions) ? quiz.questions : []), [quiz]);

  // 换了一份卷子（重新出题 / 换了方向）就清空作答：把上一份的答案贴到新题上是最糟的错
  useEffect(() => { setAnswers({}); setVerdicts({}); setTip(''); setPendingAI([]); setAiTotal(0); }, [quiz]);

  const apply = useCallback((i, v) => setVerdicts((prev) => ({ ...prev, [i]: v })), []);

  /** 改作答就把这题的判定作废 —— 否则会出现"答案改了、判定还是旧的" */
  const setAnswer = useCallback((i, value) => {
    setAnswers((prev) => ({ ...prev, [i]: value }));
    setVerdicts((prev) => {
      if (!prev[i]) return prev;
      const next = { ...prev };
      delete next[i];
      return next;
    });
  }, []);

  /** 选择题：点选项即判（用户明确要的手感：四个选项真的能点，点了立刻知道对错） */
  const chooseOption = useCallback((i, letter) => {
    if (verdictsRef.current[i]) return;   // 已判过就不让再选（能改就等于自己骗自己）
    setAnswers((prev) => ({ ...prev, [i]: letter }));
    const v = judgeLocally(qs[i], letter);
    if (v) apply(i, v);
  }, [qs, apply]);

  /** 填空 / 改错：输入框旁边那个「核对」 */
  const judgeOne = useCallback((i) => {
    const v = judgeLocally(qs[i], answersRef.current[i]);
    if (v) apply(i, v);
    return v;
  }, [qs, apply]);

  /** 自己判（AI 用不了时主观题的兜底） */
  const selfJudge = useCallback((i, ok) => {
    apply(i, { status: ok ? 'right' : 'wrong', by: 'self', expected: String((qs[i] && qs[i].answer) || '') });
  }, [qs, apply]);

  /** 批改整卷：先本地判一遍，再把拿不准的（主观题/存疑题）一次性交给 AI */
  const gradeAll = useCallback(async () => {
    if (!qs.length) return;
    setTip('');
    const base = { ...verdictsRef.current };
    const askAI = [];
    qs.forEach((q, i) => {
      let v = base[i];
      if (!v) {
        v = judgeLocally(q, answersRef.current[i]);
        if (v) base[i] = v;
      }
      // 已经由 AI 或学生自己判过的不再送一遍（重复提交＝白花钱）
      if (v && (v.by === 'ai' || v.by === 'self')) return;
      if (needsAIGrade(q, v)) askAI.push(i);
    });
    setVerdicts(base);
    if (!askAI.length) return;

    // 题干/答案都为空的题服务端会丢掉，位置就会错位 —— 这里先用**同一个判据**筛一遍，
    // 保证"这批第 k 题"在两边指的是同一道题（否则点评会贴到别的题上）。
    const batch = askAI.filter((i) => qs[i].question || qs[i].answer).slice(0, MAX_GRADE_ITEMS);
    if (askAI.length > batch.length) setTip('这次只批改了前 ' + batch.length + ' 道需要 AI 的题，其余请再点一次「批改」。');
    // 送给服务端的题号是**批次内的位置**（0..n-1），回来的也是位置 —— 服务端不认客户端题号，
    // 免得"卷子第 7 题"和"这批第 2 题"混在一起（那会把点评贴到别的题上）。
    const items = batch.map((i, k) => ({
      index: k,
      type: qs[i].type || '',
      question: qs[i].question || '',
      options: Array.isArray(qs[i].options) ? qs[i].options : [],
      answer: qs[i].answer || '',
      explanation: qs[i].explanation || '',
      userAnswer: String(answersRef.current[i] == null ? '' : answersRef.current[i]),
    }));
    setPendingAI(batch);
    setAiTotal(batch.length);
    try {
      await run({
        submit: () => quizApi({
          mode: 'grade', items, level: quiz.level,
          // 流式：模型一行一道题地往外写，收到一条就贴一条（见 server/gradeStream.mjs）
          stream: true,
          baseUrl: settings && settings.baseUrl, model: settings && settings.model, apiKey: settings && settings.apiKey,
        }),
        fetchJob: getQuizJob,
        stream: {
          path: (jid) => '/api/quiz/' + jid + '/stream',
          onEvent: (name, payload) => {
            if (name !== 'grade' || !payload || !payload.grade) return;
            const qi = batch[payload.grade.index];      // 位置 → 卷子上的题号
            if (qi == null) return;
            setVerdicts((prev) => ({
              ...prev,
              [qi]: {
                status: payload.grade.verdict || 'close',
                by: 'ai',
                expected: String((qs[qi] && qs[qi].answer) || ''),
                comment: payload.grade.comment || '',
                better: payload.grade.better || '',
              },
            }));
            setPendingAI((prev) => prev.filter((x) => x !== qi));   // 这题已判，撤掉"批改中"
          },
        },
        intervalMs: POLL_QUIZ_MS,
        timeoutMs: TIMEOUT_QUIZ_MS,
        maxFailures: 8,
        netError: '网络不稳定，暂时无法批改',
        timeoutError: '批改超时，请重试',
        texts: { submit: '正在提交批改…', running: 'AI 正在批改主观题…' },
        onData: (data) => {
          const grades = Array.isArray(data && data.grades) ? data.grades : [];
          if (!grades.length) throw new Error('没有拿到批改结果，请重试');
          setVerdicts((prev) => {
            const next = { ...prev };
            for (const g of grades) {
              const qi = batch[g.index];                      // 位置 → 卷子上的题号
              if (qi == null) continue;
              next[qi] = {
                status: g.verdict || 'close',
                by: 'ai',
                expected: String((qs[qi] && qs[qi].answer) || ''),
                comment: g.comment || '',
                better: g.better || '',
              };
            }
            return next;
          });
        },
      });
    } catch (e) {
      // AI 用不了（后端没起 / 没配 Key / 网络抖）→ 主观题退回自评，本地判的结论照常留着
      setVerdicts((prev) => {
        const next = { ...prev };
        for (const i of batch) {
          const local = next[i];
          if (local && local.by === 'ai') continue;
          next[i] = {
            status: 'pending',
            by: 'self',
            expected: String((qs[i] && qs[i].answer) || ''),
            local: local && local.status ? local.status : '',
          };
        }
        return next;
      });
      setTip('AI 批改暂时用不了（' + ((e && e.message) || '未知错误') + '）：主观题请对照下面的标准答案自己判一下。本地能判的题已经判完了。');
    } finally {
      setPendingAI([]);
    }
  }, [qs, quiz, settings, run]);

  const resetAll = useCallback(() => {
    setAnswers({});
    setVerdicts({});
    setTip('');
  }, []);

  /** 只重做一道题（选择题选错手滑时不必整卷重来） */
  const clearOne = useCallback((i) => {
    setAnswers((prev) => { const next = { ...prev }; delete next[i]; return next; });
    setVerdicts((prev) => { const next = { ...prev }; delete next[i]; return next; });
  }, []);

  const summary = useMemo(() => summarizeVerdicts(verdicts, qs.length), [verdicts, qs.length]);

  return {
    answers, verdicts, summary, tip, aiBusy, aiElapsed: elapsed,
    // AI 批改进度：total = 这一批几道题，pending = 还在等的题号（逐题到达时实时收缩）
    aiProgress: { total: aiTotal, pending: pendingAI, done: Math.max(0, aiTotal - pendingAI.length) },
    setAnswer, chooseOption, judgeOne, gradeAll, selfJudge, resetAll, clearOne,
    modeOf: (i) => gradingMode(qs[i]),
  };
}
