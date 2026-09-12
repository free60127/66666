/**
 * 编辑区（作业内容 + AI 素材生成）。
 *
 * 这里管的是"用户正在写/生成的那篇作业"：标题、中文提示、英文初稿、英文原文、
 * 以及 AI 原创素材（主题/难度/文体 + 生成流程）。
 *
 * 边界：
 * · 选课（selectLesson/selectMyLesson）由 App 负责，它通过这里返回的 setter 写入内容；
 * · `currentOriginal`（原文来源的优先级合并）与全局错误条 `error` 仍留在 App ——
 *   前者同时依赖选课状态，后者是所有链路共用的。
 */
import { useCallback, useState } from 'react';
import { generateMaterial, getMaterialJob } from '../api.js';
import { POLL_ANALYZE_MS, TIMEOUT_ANALYZE_MS, POLL_MAX_FAILURES } from '../constants.js';

/**
 * @param {object} o
 * @param {object} o.settings AI 设置（素材生成用同一套 Key/模型）
 * @param {object} o.runMaterialJob 素材链路的 useJobRunner 实例
 * @param {Function} o.setError 全局错误条
 * @param {Function} o.setMatchedLesson 生成素材后要清掉"当前匹配到的课文"
 * @param {Function} o.setMode 生成素材后切到自由模式
 */
export function useEditor({ settings, runMaterialJob, setError, setMatchedLesson, setMode }) {
  const [title, setTitle] = useState('');
  const [chinese, setChinese] = useState('');
  const [draft, setDraft] = useState('');
  const [manualOriginal, setManualOriginal] = useState('');
  const [originalOpen, setOriginalOpen] = useState(false);
  const [generatedOriginal, setGeneratedOriginal] = useState('');
  const [materialKeywords, setMaterialKeywords] = useState([]);
  const [matchConfidence, setMatchConfidence] = useState('');
  const [matchScore, setMatchScore] = useState(null);
  // AI 素材弹窗里的三个选择（弹窗开关归 useModals）
  const [materialTopic, setMaterialTopic] = useState('');
  const [materialLevel, setMaterialLevel] = useState('中级');
  const [materialStyle, setMaterialStyle] = useState('生活故事');

  /**
   * 生成 AI 原创素材（无版权英文短文 + 中文翻译），当作回译题源。
   * 生成完直接把内容填进编辑区，并切到自由模式 —— 素材不是教材里的课文。
   */
  const handleGenerateMaterial = useCallback(async (closeMaterialModal) => {
    const topic = materialTopic.trim();
    if (!topic) { setError('请填写素材主题'); return; }
    setError('');
    try {
      await runMaterialJob({
        submit: () => generateMaterial({
          topic, level: materialLevel, style: materialStyle,
          baseUrl: settings.baseUrl, model: settings.model, apiKey: settings.apiKey,
        }),
        fetchJob: getMaterialJob,
        intervalMs: POLL_ANALYZE_MS,
        timeoutMs: TIMEOUT_ANALYZE_MS,
        maxFailures: POLL_MAX_FAILURES,
        netError: '网络不稳定，暂时无法获取素材，请重试',
        timeoutError: '生成素材超时（超过10分钟），请重新提交',
        onData: (data) => {
          const d = data || {};
          if (!d.original || !d.chinese) throw new Error('AI 返回内容不完整，请重试');
          setTitle(d.title || topic);
          setChinese(d.chinese);
          setDraft('');
          setGeneratedOriginal(d.original);
          // AI 素材的原文也要填进「英文原文」输入框，否则用户只看到空框
          // （之前只写进 generatedOriginal，折叠栏显示"已自动带入 N 词"但框里是空的）
          setManualOriginal(d.original || '');
          setMaterialKeywords(d.keywords || []);
          setMatchedLesson(null);
          setMode('free');
          setMatchConfidence('none');
          setMatchScore(null);
          if (closeMaterialModal) closeMaterialModal();
        },
      });
    } catch (e) {
      setError(e.message || '素材生成失败');
    }
  }, [materialTopic, materialLevel, materialStyle, settings, runMaterialJob, setError, setMatchedLesson, setMode]);

  /** 清空编辑区（「新建作业」用） */
  const clearEditor = useCallback(() => {
    setTitle('');
    setChinese('');
    setDraft('');
    setManualOriginal('');
    setGeneratedOriginal('');
    setMaterialKeywords([]);
    setMatchConfidence('');
    setMatchScore(null);
  }, []);

  return {
    title, setTitle, chinese, setChinese, draft, setDraft,
    manualOriginal, setManualOriginal, originalOpen, setOriginalOpen,
    generatedOriginal, setGeneratedOriginal, materialKeywords, setMaterialKeywords,
    matchConfidence, setMatchConfidence, matchScore, setMatchScore,
    materialTopic, setMaterialTopic, materialLevel, setMaterialLevel, materialStyle, setMaterialStyle,
    handleGenerateMaterial, clearEditor,
  };
}
