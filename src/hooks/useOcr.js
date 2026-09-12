import { useEffect, useRef, useState } from 'react'
import { getOcrJob, ocr } from '../api.js'
import { POLL_OCR_MS, TIMEOUT_OCR_MS } from '../constants.js'
import { prepareImage } from '../ocrImage.js'
import { submitAndPoll } from './pollJob.js'

/**
 * 拍照 / 相册 / 拖拽 → 识别 → 填入三个输入框（中文提示 / 英文初稿 / 英文原文）。
 *
 * 从 App.jsx 抽出来（原来散在 120 多行里）：状态、refs、摄像头生命周期、
 * 识别轮询全在这里。变量名沿用原来的，App 的 JSX 一处都不用改。
 *
 * 边界说明：
 * · `camOpen`（摄像头弹窗开关）留在 useModals —— Esc / 焦点陷阱要认它；
 * · `setError` 由 App 传入，识别失败与摄像头失败都走全局错误条。
 *
 * @param {object} o
 * @param {object} o.settings 后端地址/模型/Key（含 visionModel）
 * @param {object} o.aliveRef 组件是否还活着（轮询到点前先看它，避免卸载后 setState）
 * @param {boolean} o.camOpen 摄像头弹窗是否打开
 * @param {Function} o.setCamOpen 开关摄像头弹窗
 * @param {Function} o.setError 全局错误条
 * @param {Function} o.setChinese 填入中文提示
 * @param {Function} o.setDraft 追加到英文初稿
 * @param {Function} o.setManualOriginal 追加到英文原文
 * @param {object} o.closeCameraRef 供 useModals 在 Esc 关闭时调用（由本 hook 回填）
 */
export function useOcr({
  settings, aliveRef, camOpen, setCamOpen, setError,
  setChinese, setDraft, setManualOriginal, closeCameraRef,
}) {
  const [ocrBusy, setOcrBusy] = useState(null); // null | 'chinese' | 'english' | 'original'
  const [ocrMode, setOcrMode] = useState('auto'); // auto | handwriting | printed
  const [ocrNotes, setOcrNotes] = useState({});
  const [dragOver, setDragOver] = useState(null); // null | 'chinese' | 'english' | 'original'
  const [camSide, setCamSide] = useState('english');
  const [camError, setCamError] = useState('');
  const camVideoRef = useRef(null);
  const camStreamRef = useRef(null);
  const chineseCamRef = useRef(null);
  const chineseFileRef = useRef(null);
  const englishCamRef = useRef(null);
  const englishFileRef = useRef(null);
  const originalCamRef = useRef(null);   // 英文原文（标准答案）框的拍照 / 选图
  const originalFileRef = useRef(null);

  const handleOcrFiles = async (side, files) => {
    const list = Array.from(files || []).filter((f) => f && /^image\//i.test(f.type || ''));
    if (!list.length) { setError('请选择图片文件（JPG / PNG / WEBP 等）'); return; }
    if (ocrBusy) return;
    // 三个目标框共用一条识别链路：服务端只认 chinese / english 两种语言，
    // 「英文原文」框用 english 识别、但结果落到 manualOriginal。
    const target = side === 'chinese'
      ? { lang: 'chinese', apply: setChinese, done: '已填入中文提示' }
      : side === 'original'
        ? { lang: 'english', apply: setManualOriginal, done: '已追加到英文原文' }
        : { lang: 'english', apply: setDraft, done: '已追加到英文初稿' };
    setError('');
    setOcrBusy(side);
    setOcrNotes((n) => ({ ...n, [side]: '正在准备图片…' }));
    try {
      const texts = [];
      for (let i = 0; i < list.length; i += 1) {
        setOcrNotes((n) => ({ ...n, [side]: `正在识别第 ${i + 1}/${list.length} 张…（约 5-30 秒）` }));
        const image = await prepareImage(list[i], ocrMode);
        const outcome = await submitAndPoll({
          submit: () => ocr({
            image, side: target.lang, mode: ocrMode,
            baseUrl: settings.baseUrl, model: settings.model, apiKey: settings.apiKey,
            visionModel: settings.visionModel,
          }),
          fetchJob: getOcrJob,
          intervalMs: POLL_OCR_MS,
          timeoutMs: TIMEOUT_OCR_MS,
          maxFailures: 8,
          netError: '网络不稳定，暂时无法获取识别结果，请重试',
          timeoutError: '识别超时（超过 3 分钟），请换更清晰的照片或重新拍一张',
          isAlive: () => aliveRef.current,
        });
        if (outcome.aborted) return;
        const text = (outcome.data && outcome.data.text) || '';
        if (!text) throw new Error('识别超时（超过 3 分钟），请换更清晰的照片或重新拍一张');
        texts.push(text);
      }
      const merged = texts.join('\n\n');
      target.apply((prev) => (prev && prev.trim() ? prev.replace(/\s+$/, '') + '\n\n' + merged : merged));
      setOcrNotes((n) => ({ ...n, [side]: `识别完成：${merged.length} 字，${target.done}，请核对后再生成` }));
    } catch (e) {
      setOcrNotes((n) => ({ ...n, [side]: '识别失败：' + (e.message || '未知错误') }));
    } finally {
      setOcrBusy(null);
    }
  };

  const openCamera = async (side) => {
    setCamError('');
    const fallbackInput = side === 'chinese' ? chineseCamRef.current : side === 'original' ? originalCamRef.current : englishCamRef.current;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      fallbackInput?.click();
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } },
        audio: false,
      });
      // 先停掉上一次的流：否则第二次 getUserMedia 之后旧轨道泄漏，摄像头指示灯一直不灭
      try { camStreamRef.current?.getTracks().forEach((t) => t.stop()); } catch { /* ignore */ }
      camStreamRef.current = stream;
      setCamSide(side);
      setCamOpen(true);
    } catch (e) {
      setError('无法打开摄像头（' + (e.message || '权限被拒绝') + '），已打开系统选择器：可拍照或从相册选择');
      fallbackInput?.click();
    }
  };

  const closeCamera = () => {
    try { camStreamRef.current?.getTracks().forEach((t) => t.stop()); } catch { /* ignore */ }
    camStreamRef.current = null;
    setCamOpen(false);
    setCamError('');
  };
  closeCameraRef.current = closeCamera; // 供 useModals 在 Esc 关闭时调用

  const snapPhoto = async () => {
    const video = camVideoRef.current;
    if (!video || !video.videoWidth) { setCamError('相机画面尚未就绪，请稍候再点拍照'); return; }
    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    canvas.getContext('2d').drawImage(video, 0, 0);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.95));
    if (!blob) { setCamError('拍照失败，请重试'); return; }
    const file = new File([blob], 'camera-' + Date.now() + '.jpg', { type: 'image/jpeg' });
    const side = camSide;
    closeCamera();
    await handleOcrFiles(side, [file]);
  };

  // 桌面端：防止图片被拖到页面空白处时浏览器直接打开图片；同时负责组件卸载时关掉摄像头
  useEffect(() => {
    const prevent = (e) => { e.preventDefault(); };
    window.addEventListener('dragover', prevent);
    window.addEventListener('drop', prevent);
    return () => {
      window.removeEventListener('dragover', prevent);
      window.removeEventListener('drop', prevent);
      try { camStreamRef.current?.getTracks().forEach((t) => t.stop()); } catch { /* ignore */ }
    };
  }, []);

  // 摄像头弹窗打开后再绑定视频流（保证 <video> 已挂载）
  useEffect(() => {
    if (!camOpen) return;
    const v = camVideoRef.current;
    if (v && camStreamRef.current) {
      v.srcObject = camStreamRef.current;
      v.play().catch(() => {});
    }
  }, [camOpen]);

  return {
    ocrBusy, ocrMode, setOcrMode, ocrNotes, setOcrNotes,
    dragOver, setDragOver, camSide, camError,
    camVideoRef, chineseCamRef, chineseFileRef,
    englishCamRef, englishFileRef, originalCamRef, originalFileRef,
    handleOcrFiles, openCamera, closeCamera, snapPhoto,
  };
}
