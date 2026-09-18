import { useEffect, useRef, useState } from 'react'
import { analyze, deleteAnalyzeJob, getAnalyzeJob } from '../api.js'
import { DEMO_LESSON_18 } from '../demo.js'
import { formatDuration } from '../format.js'
import { normalizeDirection } from '../direction.js'
import { hasMorphology, morphologyText } from '../favorites.js'
import {
  DELETED_HISTORY_MAX, loadDeletedHistory, loadHistory, loadResultCache,
  pruneResultCache, removeResultCache, saveDeletedHistory, saveHistory, saveResultCache,
} from '../storage.js'
import { POLL_ANALYZE_MS, TIMEOUT_ANALYZE_MS } from '../constants.js'
import { normalizeResult } from '../resultData.js'
import { foldSegments, SEGMENT_LABEL } from '../resultFold.js'
import { loadProgress, recordAttempt, saveProgress } from '../lessonProgress.js'
import { scoreOf } from '../progress.js'
import { loadDays, recordDay, saveDays } from '../studyStreak.js'

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
  genTokenRef, aliveRef, direction,
  setView, setError, setHistoryOpen,
  flashTip, setToast, runGenerateRef,
}) {
  // 方向走 ref：runGenerate 只在提交那一刻需要它，放进依赖会让"切方向"重建整个提交函数
  const directionRef = useRef(direction);
  directionRef.current = direction;
  const [result, setResult] = useState(null);
  const [currentJobId, setCurrentJobId] = useState('');
  const [historyList, setHistoryList] = useState(loadHistory);
  // 已删除作业号（墓碑）：云同步的历史合并是并集，没有它会"删了又出现"
  const [deletedHistory, setDeletedHistory] = useState(loadDeletedHistory);
  // 逐课进度：按 lessonKey 聚合"练过几次 / 最好多少分"，**不随历史 20 条淘汰**
  // —— 侧栏打星、"本册已练 N/96"都靠它（历史记录只能看到最近 20 次）
  const [lessonProgress, setLessonProgress] = useState(loadProgress);
  // 连续学习天数：按"天"存去重日期（历史只留 20 条，推不出哪天练过）
  const [studyDays, setStudyDays] = useState(loadDays);
  const [shareTip, setShareTip] = useState('');
  // 「取消等待」标记：不是取消任务，只是让界面解锁（见 cancelGenerate 的说明）
  const cancelGenRef = useRef(false);
  /* ---------- 流式：边生成边显示 ----------
   * 学生原来要盯着"AI 正在后台生成（约1-2分钟）"干等；现在模型一行一段地吐，
   * 每收到一段就把已到的部分折成一份结果画出来（整体评价 → 逐句解析 → 词汇 → 习语 → 句式）。
   * 流式不可用（代理缓冲/服务端没起/中途断了）时由 submitAndPoll 用同一个 jobId 回退轮询，
   * 所以这里只是"显示得快一点"，不影响任何可靠性语义。 */
  const streamSegsRef = useRef([]);     // 按 index 落位：断线重放不会折出重复内容
  const streamViewRef = useRef(false);  // 只自动切一次结果页（切过去之后就由用户自己导航）
  const [streaming, setStreaming] = useState(false);
  const [streamNote, setStreamNote] = useState('');

  // 本次作业的「英文原文（标准答案）」优先级：
  // 用户手填 > AI 素材生成的原文 > 自建库课文自带的原文。
  // 内置册留空，交给服务端按 book/lessonId 去语料里取（行为不变）。
  const currentOriginal = manualOriginal.trim()
    || generatedOriginal
    || (myLibId ? (matchedLesson?.english || '') : '');

  /**
   * 记一次"完成"（按 lessonKey 聚合）。只有真正生成成功才会走到这里 ——
   * 从历史里翻看旧结果不算重新练习，所以不在 loadHistoryJob 里调用。
   */
  const bumpProgress = (key, result, ms) => {
    const next = recordAttempt(lessonProgress, key, { score: scoreOf(result), durationMs: ms, at: Date.now() });
    if (next === lessonProgress) return; // 自由模式 / 空 key：无归属，不记录
    saveProgress(next);
    setLessonProgress(next);
  };

  /** 记"今天练过"（连续天数用）。任何成功生成都算 —— 自由模式也是在学。 */
  const bumpStudyDay = () => {
    const next = recordDay(studyDays);
    if (next === studyDays) return;
    saveDays(next);
    setStudyDays(next);
  };

  /** 结果写入历史：结果缓存跟随历史条数淘汰，否则会无限增长写满 5MB 配额。 */
  const addToHistory = (jobId, jobTitle, data, durationMs, deleteToken) => {
    saveResultCache(jobId, data);
    // lessonKey 一起进历史：结果页要靠它认出"上一次练的是同一课"（老记录没有，靠标题兜底）
    // deleteToken：删除这条记录时回传给服务端的凭据（老记录没有，服务端会放行）
    const entry = {
      jobId, title: jobTitle || '回译作业', time: Date.now(),
      durationMs: Number(durationMs) || 0,
      lessonKey: String((data && data.lessonKey) || ''),
      ...(deleteToken ? { deleteToken } : {}),
    };
    const next = [entry, ...historyList.filter((x) => x.jobId !== jobId)].slice(0, 20);
    saveHistory(next);
    pruneResultCache(next.map((x) => x.jobId)); // 结果缓存跟随历史条数淘汰，否则无限增长写满 5MB 配额
    setHistoryList(next);
  };

  /** 记录墓碑（去重 + 保上限），并同步进 state —— 云同步会把它一起推到云端。 */
  const addTombstones = (ids) => {
    const next = [...new Set([...deletedHistory, ...ids])].slice(-DELETED_HISTORY_MAX);
    saveDeletedHistory(next);
    setDeletedHistory(next);
    return next;
  };

  /**
   * 删除一条历史：**本机 + 服务端一起删**，分享链接随即失效。
   *
   * 两个容易踩的点：
   *  1) 必须先删服务端再动本机 —— 顺序反了而服务端删除失败，就留下"本机没了、云端还在"的不一致；
   *  2) 删完要留**墓碑**（deletedHistory）。云同步的历史合并是并集，不留标记的话
   *     下一次同步会把云端那份旧记录原样并回来，用户看到的就是"删了又出现"。
   * @returns {Promise<{ok: boolean, error?: string}>}
   */
  const removeFromHistory = async (jobId) => {
    if (!jobId) return { ok: false, error: '缺少任务号' };
    const entry = historyList.find((x) => x.jobId === jobId);
    try {
      await deleteAnalyzeJob(jobId, entry && entry.deleteToken);
    } catch (e) {
      // 服务端已经没有这条（过期 / 被条数上限清理）时按删除成功处理，否则用户永远删不掉一条幽灵记录
      if (!/不存在|已被删除/.test((e && e.message) || '')) {
        return { ok: false, error: (e && e.message) || '删除失败，请稍后重试' };
      }
    }
    const next = historyList.filter((x) => x.jobId !== jobId);
    saveHistory(next);
    removeResultCache(jobId); // 本机结果缓存也清掉，否则刷新后还能从缓存把内容捞回来
    setHistoryList(next);
    addTombstones([jobId]);
    return { ok: true };
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
    const dir = normalizeDirection(directionRef.current);
    const cn = chinese.trim();
    const df = draft.trim();
    // 提示语跟着方向走：英译汉时源栏装的是英文原文、初稿栏是中文译稿
    if (!cn) { setError(dir === 'en2cn' ? '请先填入要翻译的英文原文（或上传含英文的 DOCX）' : '请先上传包含中文提示的 DOCX，或填入中文提示'); return; }
    if (!df) { setError(dir === 'en2cn' ? '请先写下你的中文翻译' : '请先上传包含英文初稿的 DOCX，或填入英文初稿'); return; }
    setError('');
    cancelGenRef.current = false; // 新的生成开始，清掉上一次的取消标记
    streamSegsRef.current = [];
    streamViewRef.current = false;
    const myToken = (genTokenRef.current += 1);
    // 点击生成时定格用时（本次练习从开始计时到提交用掉的时长）
    const durationMs = elapsedMsNow(); // 定格「从开始计时到提交」的用时（不算等 AI 的时间）
    let jobId = '';
    let deleteToken = ''; // 创建响应里只发一次的删除凭据，随历史条目一起存，删记录时回传
    try {
      await runJob({
        submit: async () => {
          const resp = await analyze({
          title: title.trim(), chinese: cn, draft: df,
          direction: dir,   // 服务端据此选 prompt；结果里也会带回来，供结果页决定标签
          book: mode === 'lesson' && !myLibId ? book : undefined,
          lessonId: mode === 'lesson' && !myLibId ? id : undefined,
          original: currentOriginal || undefined,
          level: polishLevel,
          // 流式：服务端一行一段地往外写，前端边收边画（见下面的 stream 配置）。
          // 服务端不认识这个字段时会忽略它 —— 老后端 + 新前端也不会出错。
          stream: true,
          baseUrl: settings.baseUrl, model: settings.model, apiKey: settings.apiKey,
          });
          deleteToken = (resp && resp.deleteToken) || '';
          return resp;
        },
        fetchJob: getAnalyzeJob,
        intervalMs: POLL_ANALYZE_MS,
        timeoutMs: TIMEOUT_ANALYZE_MS,
        maxFailures: 10,
        netError: '网络不稳定，暂时无法获取生成结果，请重试',
        timeoutError: '等待超时（已等 10 分钟）。任务可能还在后台跑：稍后刷新本页就能看到这次结果（任务号已记在地址栏），不必重新提交。',
        texts: { submit: '正在提交后台任务…', running: 'AI 正在后台生成（约1-2分钟）…', done: '生成完成' },
        /* 流式：边收边画。首段到达就把视图切到结果页 —— 这是"不再干等一分钟"的全部意义。
           折叠规则见 src/resultFold.js（与服务端 server/analyzeStream.mjs 同构，
           test/analyzeStream.test.mjs 交叉断言两边一致）。 */
        stream: {
          path: (jid) => '/api/analyze/' + jid + '/stream',
          onFirst: () => setStreaming(true),
          onEvent: (name, payload) => {
            if (name !== 'segment' || !payload) return;
            if (Number.isInteger(payload.index)) streamSegsRef.current[payload.index] = { ...payload.seg, __i: payload.index };
            else streamSegsRef.current.push(payload.seg);
            const partial = foldSegments(streamSegsRef.current.filter(Boolean));
            const sentences = partial.sentences.length;
            setStreamNote((payload.label || SEGMENT_LABEL[payload.seg && payload.seg.t] || '解析')
              + (payload.seg && payload.seg.t === 'sentence' ? ' · 第 ' + sentences + ' 句' : ''));
            setResult(normalizeResult({ ...partial, direction: dir, aiLevel: polishLevel, durationMs, lessonKey, attemptTime: Date.now() }));
            // 用户在等待期间切过课 / 点过「取消等待」就不抢视图（与 onData 的规则一致）
            if (!streamViewRef.current && !cancelGenRef.current && myToken === genTokenRef.current) {
              streamViewRef.current = true;
              setView('result');
            }
          },
        },
        onJobId: (id2) => {
          jobId = id2;
          // 拿到任务号就立刻写进地址栏：这是"任务还在后台、但界面这边已经放弃"时的唯一入口
          // （等待超时 / 手机锁屏太久 / 用户自己刷新）。
          // 原来只有成功回调（onData）里才写，于是超时或中断后用户既没有历史记录、
          // 也没有 #job=，只能重新提交 —— 再花一次模型调用的钱。
          // 恢复路径见本文件底部的 #job= effect：已完成 → 直接出结果；
          // 仍在跑 → 提示"仍在生成中，请稍后刷新查看"（不会静默丢单）。
          window.history.replaceState(null, '', '#job=' + id2);
        },
        onData: (data) => {
          // 流式结束：用服务端**收敛过的完整结果**覆盖边生成边画的那份
          //（"看到的"和"存进历史的"由此收敛成同一个东西）
          setStreaming(false);
          setStreamNote('');
          // attemptTime：这次练习的时间戳。结果页要靠它判断"哪次才算上一次"
          // （从历史里点开旧作业时，比它更晚的练习不能算"上次"）。
          const enriched = { ...(data || {}), durationMs, lessonKey, attemptTime: Date.now() };
          setResult(normalizeResult(enriched));
          if (jobId) setCurrentJobId(jobId);
          // 三种情况都不抢视图：生成期间用户切过课 / 点过「新建」/ 点过「取消等待」。
          // 但结果照常入历史 —— 用户随时能从「历史结果」里打开。
          const cancelled = cancelGenRef.current;
          // 流式已经切过一次结果页了：收尾时**不再抢视图** —— 用户看完结果回到编辑器继续改，
          // 不该在任务完成的那一刻又被拽回结果页（轮询那条路径没切过，照旧在这里切）。
          if (!cancelled && myToken === genTokenRef.current && !streamViewRef.current) setView('result');
          if (jobId) {
            addToHistory(jobId, (data && data.title) || title, enriched, durationMs, deleteToken);
            bumpProgress(lessonKey, enriched, durationMs);
            bumpStudyDay();
            window.history.replaceState(null, '', '#job=' + jobId);
          }
          if (cancelled) flashTip(setToast, '刚才那篇已经生成好，存进「历史结果」了', 6000);
        },
      });
    } catch (e) {
      setStreaming(false);
      setStreamNote('');
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
    // 流式那条横幅也一起收掉：用户说了"不等了"，界面上就该干净
    //（流本身继续跑，跑完照样入历史 —— 与轮询那条路径的语义一致）
    setStreaming(false);
    setStreamNote('');
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
    deletedHistory, setDeletedHistory, addTombstones, removeFromHistory,
    lessonProgress, setLessonProgress, bumpProgress, studyDays, setStudyDays, bumpStudyDay,
    currentOriginal,
    streaming, streamNote,
    runGenerate, cancelGenerate, addToHistory, openHistoryModal, loadHistoryJob,
    shareResult, copyAll, loadDemo,
  };
}
