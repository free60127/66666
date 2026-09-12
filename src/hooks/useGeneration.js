import { useEffect, useRef, useState } from 'react'
import { analyze, getAnalyzeJob } from '../api.js'
import { DEMO_LESSON_18 } from '../demo.js'
import { formatDuration } from '../format.js'
import { hasMorphology, morphologyText } from '../favorites.js'
import { loadHistory, loadResultCache, pruneResultCache, saveHistory, saveResultCache } from '../storage.js'
import { POLL_ANALYZE_MS, TIMEOUT_ANALYZE_MS } from '../constants.js'
import { normalizeResult } from '../resultData.js'

/**
 * 生成结果的「一份数据 + 一整条链路」：提交 → 轮询 → 入历史 → 结果页 / 分享 / 复制 / 离线示例。
 *
 * 从 App.jsx 抽出来（原来散在 400 多行里）。抽的时候有个硬约束：**变量名一个都没改**，
 * `result / view / historyList / runGenerate / cancelGenerate / loadDemo ...` 仍是原来的名字，
 * 所以 App 里几十处调用点不用动。
 *
 * 边界说明：
 * · `view`（编辑器/结果页/自测题）留在 App —— 它是导航状态，收藏夹/自测题也要切，
 *   放进这里会让 hook 之间互相依赖。
 * · `genTokenRef` 由 App 持有并传进来 —— 选课（useLessons）也要靠它作废正在跑的生成。
 *
 * @param {object} o
 * @param {string} o.title 作业标题（提交给后端当标题用）
 * @param {string} o.chinese 中文提示
 * @param {string} o.draft 英文初稿
 * @param {string} o.manualOriginal 手填的英文原文
 * @param {string} o.generatedOriginal AI 素材生成的英文原文
 * @param {string} o.mode 'lesson' | 'free'
 * @param {number|string} o.book 内置课本号
 * @param {number|string} o.lessonId 课号
 * @param {string} o.myLibId 自建库 id（非空说明练的是自建课文）
 * @param {object} o.matchedLesson 当前匹配到的课文
 * @param {string} o.lessonKey 计时/对比用的稳定 key
 * @param {object} o.settings 后端地址/模型/Key
 * @param {string} o.polishLevel 润色等级
 * @param {Function} o.runJob 提交 + 轮询（hooks/useJobRunner.js）
 * @param {boolean} o.busy 是否正在生成
 * @param {Function} o.cancelProgress 取消等待（不取消任务）
 * @param {Function} o.elapsedMsNow 取当前计时毫秒数
 * @param {object} o.genTokenRef 生成令牌（切课/新建/看历史都会 +1 作废在跑的任务）
 * @param {object} o.aliveRef 组件是否还活着（分享链接恢复结果时避免卸载后 setState）
 * @param {Function} o.setView 切视图
 * @param {Function} o.setError 全局错误条
 * @param {Function} o.setHistoryOpen 历史弹窗开关
 * @param {Function} o.flashTip 气泡提示 (setter, msg, ms)
 * @param {Function} o.setToast 全局 toast 的 setter
 * @param {object} o.runGenerateRef 反填给 useLessons 的「选课即生成」入口
 */
export function useGeneration({
  title, chinese, draft, manualOriginal, generatedOriginal,
  mode, book, lessonId, myLibId, matchedLesson, lessonKey,
  settings, polishLevel, runJob, busy, cancelProgress, elapsedMsNow,
  genTokenRef, aliveRef,
  setView, setError, setHistoryOpen,
  flashTip, setToast, runGenerateRef,
}) {
  const [result, setResult] = useState(null);
  const [currentJobId, setCurrentJobId] = useState('');
  const [historyList, setHistoryList] = useState(loadHistory);
  const [shareTip, setShareTip] = useState('');
  // 「取消等待」标记：不是取消任务，只是让界面解锁（见 cancelGenerate 的说明）
  const cancelGenRef = useRef(false);

  // 本次作业的「英文原文（标准答案）」优先级：
  // 用户手填 > AI 素材生成的原文 > 自建库课文自带的原文。
  // 内置册留空，交给服务端按 book/lessonId 去语料里取（行为不变）。
  const currentOriginal = manualOriginal.trim()
    || generatedOriginal
    || (myLibId ? (matchedLesson?.english || '') : '');

  /** 结果写入历史：结果缓存跟随历史条数淘汰，否则会无限增长写满 5MB 配额。 */
  const addToHistory = (jobId, jobTitle, data, durationMs) => {
    saveResultCache(jobId, data);
    // lessonKey 一起进历史：结果页要靠它认出"上一次练的是同一课"（老记录没有，靠标题兜底）
    const entry = { jobId, title: jobTitle || '回译作业', time: Date.now(), durationMs: Number(durationMs) || 0, lessonKey: String((data && data.lessonKey) || '') };
    const next = [entry, ...historyList.filter((x) => x.jobId !== jobId)].slice(0, 20);
    saveHistory(next);
    pruneResultCache(next.map((x) => x.jobId)); // 结果缓存跟随历史条数淘汰，否则无限增长写满 5MB 配额
    setHistoryList(next);
  };

  const openHistoryModal = () => {
    setHistoryList(loadHistory());
    setHistoryOpen(true);
  };

  // 连点两条历史时，先发的慢请求后返回会把后点的那条覆盖掉 —— 用请求令牌丢弃过期结果
  const historyReqRef = useRef(0);
  const loadHistoryJob = async (jobId) => {
    const reqId = (historyReqRef.current += 1);
    genTokenRef.current += 1; // 打开历史结果时作废掉正在跑的生成任务，避免它稍后抢回视图
    // 优先用本机缓存，秒开且不受服务器任务清理影响
    const cached = loadResultCache(jobId);
    if (cached) {
      setHistoryOpen(false);
      setResult(normalizeResult(cached));
      setCurrentJobId(jobId);
      setView('result');
      setError('');
      window.history.replaceState(null, '', '#job=' + jobId);
      return;
    }
    try {
      const r = await getAnalyzeJob(jobId);
      if (reqId !== historyReqRef.current) return;
      const job = r.job;
      setHistoryOpen(false);
      if (job?.status === 'done' && job.data) {
        setResult(normalizeResult(job.data));
        setCurrentJobId(jobId);
        setView('result');
        setError('');
        window.history.replaceState(null, '', '#job=' + jobId);
      } else if (job?.status === 'error') {
        setError(job.error || '该任务生成失败');
      } else {
        setError('该结果仍在生成中或已超时，请稍后再试');
      }
    } catch (e) {
      if (reqId !== historyReqRef.current) return;
      setHistoryOpen(false);
      // 服务器任务已过期/重新部署丢失时，尝试用本机缓存的结果兜底
      const fallback = loadResultCache(jobId);
      if (fallback) {
        setResult(normalizeResult(fallback));
        setCurrentJobId(jobId);
        setView('result');
        setError('');
        window.history.replaceState(null, '', '#job=' + jobId);
      } else {
        setError(e.message || '无法读取该结果');
      }
    }
  };

  const shareResult = async () => {
    if (!currentJobId) { flashTip(setShareTip, '当前是离线示例，没有可分享的结果链接', 4000); return; }
    const url = window.location.origin + window.location.pathname + '#job=' + currentJobId;
    try {
      await navigator.clipboard.writeText(url);
      setError('');
      flashTip(setShareTip, '分享链接已复制，可发给老师或同学', 4000);
    } catch {
      setShareTip('复制失败，请手动复制链接：' + url);
    }
  };

  // 通过分享链接 #job=xxx 打开时，直接恢复该次生成结果（即使后端重启过，任务已持久化）
  useEffect(() => {
    const m = window.location.hash.match(/^#job=([A-Za-z0-9-]{8,64})/);
    if (!m) return;
    const jobId = m[1];
    getAnalyzeJob(jobId).then((r) => {
      if (!aliveRef.current) return;
      if (r.job?.status === 'done' && r.job.data) {
        setResult(normalizeResult(r.job.data)); // 归一化：坏数据不再让页面白屏，F5 也不会循环崩
        setCurrentJobId(jobId);
        setView('result');
        setError('');
      } else if (r.job?.status === 'error') {
        setError(r.job.error || '该任务生成失败');
      } else {
        setError('该结果仍在生成中，请稍后刷新查看');
      }
    }).catch(() => {
      if (!aliveRef.current) return;
      // 服务端已经查不到这条任务时，用本机缓存恢复（分享者本人 / 同一台设备还留着结果）
      const cached = loadResultCache(jobId);
      if (cached) {
        setResult(normalizeResult(cached));
        setCurrentJobId(jobId);
        setView('result');
        setError('');
      } else {
        // 服务端只认它自己留着的记录（默认保留期见 /api/status 的 jobs.ttlDays）。
        // 链接打不开时要给出可操作的下一步，而不是一句"不存在"。
        setError('这条分享链接打不开了：服务端已经没有这次批改的记录（链接被改动过，或结果已超出保留期）。'
          + '请让分享者重新「复制分享链接」发一次；想长期留存，用结果页的「导出 PDF」另存一份最稳妥。');
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 只在首屏跑一次（与迁移前一致）
  }, []);

  const runGenerate = async (overrideLessonId) => {
    const id = overrideLessonId ?? lessonId;
    const cn = chinese.trim();
    const df = draft.trim();
    if (!cn) { setError('请先上传包含中文提示的 DOCX，或填入中文提示'); return; }
    if (!df) { setError('请先上传包含英文初稿的 DOCX，或填入英文初稿'); return; }
    setError('');
    cancelGenRef.current = false; // 新的生成开始，清掉上一次的取消标记
    const myToken = (genTokenRef.current += 1);
    // 点击生成时定格用时（本次练习从开始计时到提交用掉的时长）
    const durationMs = elapsedMsNow(); // 定格「从开始计时到提交」的用时（不算等 AI 的时间）
    let jobId = '';
    try {
      await runJob({
        submit: () => analyze({
          title: title.trim(), chinese: cn, draft: df,
          book: mode === 'lesson' && !myLibId ? book : undefined,
          lessonId: mode === 'lesson' && !myLibId ? id : undefined,
          original: currentOriginal || undefined,
          level: polishLevel,
          baseUrl: settings.baseUrl, model: settings.model, apiKey: settings.apiKey,
        }),
        fetchJob: getAnalyzeJob,
        intervalMs: POLL_ANALYZE_MS,
        timeoutMs: TIMEOUT_ANALYZE_MS,
        maxFailures: 10,
        netError: '网络不稳定，暂时无法获取生成结果，请重试',
        timeoutError: '生成超时（超过10分钟），请重新提交',
        texts: { submit: '正在提交后台任务…', running: 'AI 正在后台生成（约1-2分钟）…', done: '生成完成' },
        onJobId: (id2) => { jobId = id2; },
        onData: (data) => {
          // attemptTime：这次练习的时间戳。结果页要靠它判断"哪次才算上一次"
          // （从历史里点开旧作业时，比它更晚的练习不能算"上次"）。
          const enriched = { ...(data || {}), durationMs, lessonKey, attemptTime: Date.now() };
          setResult(normalizeResult(enriched));
          if (jobId) setCurrentJobId(jobId);
          // 三种情况都不抢视图：生成期间用户切过课 / 点过「新建」/ 点过「取消等待」。
          // 但结果照常入历史 —— 用户随时能从「历史结果」里打开。
          const cancelled = cancelGenRef.current;
          if (!cancelled && myToken === genTokenRef.current) setView('result');
          if (jobId) {
            addToHistory(jobId, (data && data.title) || title, enriched, durationMs);
            window.history.replaceState(null, '', '#job=' + jobId);
          }
          if (cancelled) flashTip(setToast, '刚才那篇已经生成好，存进「历史结果」了', 6000);
        },
      });
    } catch (e) {
      setError(e.message);
      setView('editor');
    }
  };

  // 供 useLessons 的「选课即生成」用（那边拿的是 ref，避免互相依赖）
  if (runGenerateRef) runGenerateRef.current = runGenerate;

  /**
   * 取消等待（不是取消任务）。
   *
   * 生成请求已经发出去了、模型调用已经在跑、费用已经产生 ——
   * 停掉轮询等于把这次调用白白扔掉。所以这里只做一件事：**让界面立刻解锁**，
   * 后台继续轮询，跑完了照常存进「历史结果」，再给一条提示告诉用户去哪找。
   */
  const cancelGenerate = () => {
    if (!busy) return;
    cancelGenRef.current = true;
    cancelProgress(); // 界面立刻解锁；后台轮询继续（见 hooks/useJobRunner.js 的说明）
    flashTip(setToast, '已取消等待，可以继续编辑。后台仍在生成，完成后会存进「历史结果」。', 7000);
  };

  const loadDemo = () => {
    genTokenRef.current += 1; // 正在跑的生成任务作废，避免它完成时把示例视图抢回结果页
    setResult(DEMO_LESSON_18);
    setView('result');
    setError('');
    setCurrentJobId('');
    window.history.replaceState(null, '', window.location.pathname + window.location.search);
  };

  const copyAll = async () => {
    if (!result) return;
    const text = [
      result.title,
      result.aiLevel ? '润色等级：' + result.aiLevel : '',
      result.durationMs ? '本次练习用时：' + formatDuration(result.durationMs) : '', '', '【中文译文】', result.chinese, '', '【原稿】', result.draft, '',
      '【AI 修正版】', result.ai, '', '【课文原文】', result.original, '',
      '【逐句解析】', result.overall?.summary || '', '',
      '【分项得分】', ...(result.overall?.scoreBreakdown || []).map((b) => '· ' + b.label + '：' + b.score + '/' + (b.max || 20) + (b.comment ? '（' + b.comment + '）' : '')), '',
      ...(result.sentences || []).flatMap((s, i) => [
        String(i + 1) + '. ' + s.cn, '原稿：' + s.draft, 'AI 修正版：' + s.ai,
        '原文：' + s.original, ...(s.findings || []).map((f) => {
          const dims = Array.isArray(f.dimensions) && f.dimensions.length ? '（维度：' + f.dimensions.join('、') + '）' : '';
          const syns = Array.isArray(f.synonyms) && f.synonyms.length ? '；近义词：' + f.synonyms.map((s) => typeof s === 'string' ? s : (s.word + (s.meaning ? ' ' + s.meaning : ''))).join(' / ') : '';
          const idiom = f.idiom ? '；习语：' + f.idiom : '';
          return '· [' + f.category + '] ' + f.from + ' → ' + f.to + '：' + f.explanation + dims + syns + idiom;
        }), '',
      ]),
      '【词汇深度辨析】', ...(result.vocabularyNotes || []).map((v, i) => String(i + 1) + '. ' + v.word + (v.type ? '（' + v.type + '）' : '') + '：' + (v.meaning || '') + (v.note ? ' ' + v.note : '') + (hasMorphology(v.morphology) ? ' 【' + morphologyText(v.morphology) + '】' : '')), '',
      '【地道习语】', ...(result.idiomHighlights || []).map((id, i) => String(i + 1) + '. ' + id.idiom + (id.common ? '（普通说法：' + id.common + '）' : '') + '：' + (id.explanation || '')), '',
      '【可学习的高级句式】', ...(result.advancedSentences || []).map((a) => '· ' + a), '',
      '【加分表达】', ...(result.bonusExpressions || []).map((b) => '· ' + b), '',
    ].join('\n');
    try {
      await navigator.clipboard.writeText(text);
      flashTip(setShareTip, '已复制完整解析到剪贴板', 2500);
    } catch {
      // 非 HTTPS / 局域网 http 下 navigator.clipboard 直接是 undefined，原来会静默抛错
      flashTip(setShareTip, '复制失败：请手动选中文本复制（或改用 https 访问）', 4000);
    }
  };

  return {
    result, setResult, currentJobId, setCurrentJobId, historyList, setHistoryList, shareTip, setShareTip,
    currentOriginal,
    runGenerate, cancelGenerate, addToHistory, openHistoryModal, loadHistoryJob,
    shareResult, copyAll, loadDemo,
  };
}
