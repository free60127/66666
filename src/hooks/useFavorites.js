/**
 * 收藏夹 + 间隔重复复习（SM-2）+ 收藏自测题。
 *
 * 这三块本来就是一个域：收藏条目 → 按 SM-2 排期复习 → 用收藏出题。
 * 纯逻辑（排期、合并、筛选）早就在 favorites.js / quiz.js 里了，
 * 这里收拢的是它们的**状态与动作**（弹窗筛选、复习会话、自测题生命周期）。
 */
import { useCallback, useMemo, useRef, useState } from 'react';
import { dueFavorites, favoritesToText, filterFavorites, loadFavorites, mergeFavorites, saveFavorites, sm2Review, withSchedule } from '../favorites.js';
import { buildLocalQuiz, favoritesToQuizPoints, quizToText } from '../quiz.js';
import { POLL_QUIZ_MS, TIMEOUT_QUIZ_MS } from '../constants.js';;
import { quiz as quizApi, getQuizJob } from '../api.js';
import { useJobRunner } from './useJobRunner.js';

/**
 * @param {object} o
 * @param {Function} o.flash  提示（(setter, msg, ms) => void）
 * @param {Function} o.setView 切视图（自测题生成完要跳到试卷页）
 * @param {object} o.settings AI 设置（自测题要用同一套 Key/模型）
 * @param {string} o.polishLevel 润色等级（影响出题难度）
 */
export function useFavorites({ flash, setView, settings, polishLevel, isOpen, openFavs, closeFavs }) {
  const [favorites, setFavorites] = useState(loadFavorites);
  const [favQuery, setFavQuery] = useState('');
  const [favKind, setFavKind] = useState('all');
  const [favTip, setFavTip] = useState('');
  // 间隔重复复习会话：{ ids, index, revealed, reviewed, tally }
  const [favReview, setFavReview] = useState(null);
  // 自测题
  const [quizData, setQuizData] = useState(null);
  const [quizCount, setQuizCount] = useState(10);
  const [quizShowAnswers, setQuizShowAnswers] = useState(false); // 默认隐藏答案，先自己做
  const [quizTip, setQuizTip] = useState('');
  const favFileRef = useRef(null);
  const { busy: quizBusy, run: runQuizJob } = useJobRunner();

  /* ---------- 收藏夹（本机保存，无需数据库） ---------- */
  const toggleFavorite = useCallback((item) => {
    if (!item || !item.id) return;
    const exists = favorites.some((x) => x.id === item.id);
    const next = exists
      ? favorites.filter((x) => x.id !== item.id)
      : [{ ...withSchedule(item), createdAt: Date.now() }, ...favorites];
    const ok = saveFavorites(next);
    setFavorites(next);
    flash(setFavTip, exists ? '已取消收藏' : (ok ? '已收藏，可在右上角「收藏夹」随时复习' : '收藏失败：本机存储空间可能已满，请先导出备份'));
  }, [favorites, flash]);

  const removeFavorite = (id) => {
    const next = favorites.filter((x) => x.id !== id);
    saveFavorites(next);
    setFavorites(next);
  };
  const clearFavorites = () => {
    if (!favorites.length) return;
    if (!window.confirm('确定清空全部收藏？建议先「导出备份」。')) return;
    saveFavorites([]);
    setFavorites([]);
    flash(setFavTip, '已清空收藏', 2500);
  };
  /* ---------- 间隔重复复习（SM-2） ---------- */
  // 今天到期的收藏（due <= now）。排期字段在收藏里，所以同步码一同步，两台设备的进度就是一份。
  const favDue = useMemo(() => dueFavorites(favorites), [favorites]);
  const favDueCount = favDue.length;

  /** 开始一轮复习：把今天到期的收藏排成队列（拖得最久的先来） */
  const startReview = () => {
    setFavTip('');
    openFavs();
    const ids = dueFavorites(favorites).map((x) => x.id);
    if (!ids.length) {
      setFavReview(null);
      flash(setFavTip, '今天没有到期的收藏，休息一下～', 3000);
      return;
    }
    setFavReview({ ids, index: 0, revealed: false, reviewed: 0, tally: { forgot: 0, normal: 0, easy: 0 } });
  };

  /** 三档评分 → SM-2 更新排期 → 立即落盘（刷新/换设备都不丢） */
  const gradeFavReview = (grade) => {
    const r = favReview;
    if (!r) return;
    const id = r.ids[r.index];
    const item = favorites.find((x) => x && x.id === id);
    if (item) {
      const updated = sm2Review(item, grade, Date.now());
      const next = favorites.map((x) => (x.id === id ? updated : x));
      saveFavorites(next);
      setFavorites(next);
    }
    setFavReview({
      ...r,
      index: r.index + 1,
      revealed: false,
      reviewed: r.reviewed + (item ? 1 : 0),
      tally: item ? { ...r.tally, [grade]: (r.tally[grade] || 0) + 1 } : r.tally,
    });
  };
  const skipFavReview = () => setFavReview((r) => (r ? { ...r, index: r.index + 1, revealed: false } : r));

  const exportFavorites = () => {
    if (!favorites.length) { flash(setFavTip, '还没有收藏内容', 2000); return; }
    const blob = new Blob([JSON.stringify({ app: 'back-translate-studio', exportedAt: new Date().toISOString(), favorites }, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'retranslate-favorites-' + new Date().toISOString().slice(0, 10) + '.json';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1500);
    flash(setFavTip, '已导出备份文件，请妥善保存', 3000);
  };
  const importFavorites = async (file) => {
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      const arr = Array.isArray(data) ? data : (Array.isArray(data && data.favorites) ? data.favorites : []);
      if (!arr.filter((x) => x && x.id && x.title).length) throw new Error('文件里没有可用的收藏数据');
      const { merged, added } = mergeFavorites(arr, favorites);
      const ok = saveFavorites(merged);
      setFavorites(merged);
      flash(setFavTip, '导入完成：新增 ' + added + ' 条' + (ok ? '' : '（本机存储可能已满）'), 4000);
    } catch (e) {
      flash(setFavTip, '导入失败：' + (e.message || '文件格式不正确'), 4000);
    }
  };
  const copyFavorites = async () => {
    if (!favorites.length) return;
    try { await navigator.clipboard.writeText(favoritesToText(favorites)); flash(setFavTip, '已复制全部收藏到剪贴板', 3000); }
    catch { flash(setFavTip, '复制失败，请手动选择文本', 3000); }
  };
  // 只在收藏夹打开时才计算：原来是每帧无条件跑一遍（最多 2000 条 join + toLowerCase）
  // 只在收藏夹打开时才计算（原来每帧无条件跑一遍：最多 2000 条 join + toLowerCase）。
  // favOpen 归 useModals 管，这里用参数读，避免两个 hook 争同一份状态。
  const visibleFavorites = useMemo(
    () => (isOpen ? filterFavorites(favorites, { kind: favKind, query: favQuery }) : []),
    [isOpen, favorites, favKind, favQuery],
  );

  /* ---------- 根据收藏生成自测题 ---------- */
  const generateQuiz = async () => {
    const pool = favKind === 'all' ? favorites : filterFavorites(favorites, { kind: favKind });
    if (!pool.length) { flash(setFavTip, '还没有可用于出题的收藏', 2500); return; }
    setQuizTip('');
    setFavTip('');
    try {
      await runQuizJob({
        submit: () => quizApi({
          points: favoritesToQuizPoints(pool),
          count: quizCount,
          level: polishLevel,
          baseUrl: settings.baseUrl, model: settings.model, apiKey: settings.apiKey,
        }),
        fetchJob: getQuizJob,
        intervalMs: POLL_QUIZ_MS,
        timeoutMs: TIMEOUT_QUIZ_MS,
        maxFailures: 8,
        netError: '网络不稳定，暂时无法获取题目',
        timeoutError: '生成超时或题目为空，请重试',
        onData: (data) => {
          if (!data || !Array.isArray(data.questions) || !data.questions.length) throw new Error('生成超时或题目为空，请重试');
          setQuizData(data);
          setQuizShowAnswers(false);
          closeFavs();
          setView('quiz');
        },
      });
    } catch (e) {
      // AI 出题失败时用本地题库兜底，保证功能始终可用
      const local = buildLocalQuiz(pool, quizCount);
      if (local.questions.length) {
        setQuizData(local);
        setQuizShowAnswers(false);
        setQuizTip('AI 出题失败（' + (e.message || '未知错误') + '），已用本地题库兜底生成');
        closeFavs();
        setView('quiz');
      } else {
        flash(setFavTip, '生成失败：' + (e.message || '未知错误'), 4000);
      }
    }
  };
  const copyQuiz = async () => {
    if (!quizData) return;
    try {
      await navigator.clipboard.writeText(quizToText(quizData, { withAnswers: quizShowAnswers }));
      flash(setQuizTip, '已复制题目' + (quizShowAnswers ? '（含答案）' : '（不含答案）'), 2500);
    } catch { flash(setQuizTip, '复制失败，请手动选择文本', 2500); }
  };
  const favoritedIds = useMemo(() => new Set(favorites.map((x) => x.id)), [favorites]);
  const favHandlers = useMemo(() => ({ has: (id) => favoritedIds.has(id), toggle: toggleFavorite }), [favoritedIds, toggleFavorite]);

  return {
    favorites, setFavorites, favQuery, setFavQuery, favKind, setFavKind, favTip, setFavTip,
    favReview, setFavReview, favDue, favDueCount, visibleFavorites, favHandlers, favFileRef,
    quizData, quizCount, setQuizCount, quizShowAnswers, setQuizShowAnswers, quizTip, setQuizTip, quizBusy,
    toggleFavorite, removeFavorite, clearFavorites, exportFavorites, importFavorites, copyFavorites,
    startReview, gradeFavReview, skipFavReview, generateQuiz, copyQuiz,
  };
}
