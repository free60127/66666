/**
 * 拍照 / 图片识别（OCR）
 * 走「原生多模态视觉大模型」逐字转写中文或英文，印刷体与手写体同一套链路。
 * 零依赖：只使用 fetch + OpenAI 兼容的 chat/completions（content 数组带 image_url）。
 */

const MAX_IMAGE_BYTES = 12 * 1024 * 1024;
const VISION_TIMEOUT_MS = 120000;

function decodeImage(dataUrl) {
  const m = String(dataUrl || '').match(/^data:(image\/[A-Za-z0-9.+-]+);base64,([\s\S]+)$/);
  if (!m) throw new Error('图片数据格式不正确（需要 data:image/...;base64,...）');
  const mime = m[1].toLowerCase();
  const buf = Buffer.from(m[2], 'base64');
  if (!buf.length) throw new Error('图片内容为空');
  if (buf.length > MAX_IMAGE_BYTES) throw new Error('图片过大（超过 12MB），请压缩后重试');
  return { buf, mime };
}

/** 清理模型输出：去代码块围栏、去“识别结果：”前缀、统一空白与空行 */
export function tidyOcrText(text) {
  let t = String(text || '').replace(/\r\n?/g, '\n');
  t = t.replace(/^\s*```[A-Za-z]*\s*\n?/, '').replace(/\n?\s*```\s*$/, '');
  t = t.replace(/^\s*(识别结果|转写结果|OCR\s*结果|文字内容|识别出的文字|Text)\s*[:：]\s*/i, '');
  t = t
    .split('\n')
    .map((line) => line.replace(/[ \t\u00a0]+/g, ' ').replace(/\s+([,.;:!?，。；：！？、）】》])/g, '$1').replace(/[ \t]+$/, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return t;
}

/** 识别质量：统计乱码字符占比（既非字母数字中文、也非常规标点） */
export function textQuality(text) {
  const clean = String(text || '').replace(/\s/g, '');
  if (!clean.length) return { len: 0, badRatio: 0, garbled: false };
  let bad = 0;
  for (const ch of clean) {
    if (/[\p{L}\p{N}]/u.test(ch)) continue;
    if (/[.,'’‘"“”?!;:()\-—…《》【】、，。！？；：/·*★☆%&+@#~^|]/u.test(ch)) continue;
    bad++;
  }
  const badRatio = bad / clean.length;
  return { len: clean.length, badRatio, garbled: badRatio > 0.18 && clean.length >= 8 };
}

const BASE_PROMPTS = {
  chinese: [
    '你是一个高精度 OCR 引擎。请逐字转写这张图片中的【中文】文字（可能是手写体，也可能是印刷体、屏幕截图或拍照）。',
    '输出要求：',
    '1. 只输出识别到的文字本身。不要翻译、不要改写、不要纠正错别字、不要解释、不要加标题、不要加任何 Markdown 标记或代码块。',
    '2. 保持原文段落结构：段落之间空一行；同一段内连续书写，不要按视觉行硬换行。',
    '3. 中文标点照原文输出（，。！？、；：""\'\'《》……——）；数字、英文字母、公式符号也照抄，不要转成中文。',
    '4. 无法辨认的字用 [？] 占位；整行无法辨认就输出 [此行无法辨认]。',
    '5. 手写体要特别仔细：注意连笔与行草字形、涂改、插入与增补（增补内容按正常阅读顺序插入到对应位置）。',
    '6. 不要输出任何与图片内容无关的说明。',
  ].join('\n'),
  english: [
    'You are a high-accuracy OCR engine. Transcribe the text in this image VERBATIM. It may be handwriting, print, a screenshot, or a photo.',
    'Output rules:',
    '1. Output ONLY the transcribed text. Do not translate, do not correct spelling or grammar, do not rewrite, do not explain, do not add a title, and do not wrap the output in Markdown or code fences.',
    '2. Preserve the paragraph structure: put a blank line between paragraphs; keep the sentences of one paragraph on one continuous line instead of hard-wrapping every visual line.',
    '3. Preserve the original capitalisation, punctuation, apostrophes (\' and \'), hyphens, abbreviations and numbers exactly as written.',
    '4. Mark an unreadable word as [?] and an unreadable whole line as [unreadable line].',
    '5. Handwriting needs extra care: watch for ambiguous letter shapes (rn/m, cl/d, a/o, li/h), capitalisation, punctuation placement, corrections and insertions (insert added words in reading order).',
    '6. If the image also contains printed instructions (e.g. "Write a passage of about 120 words..."), transcribe them too.',
    '7. Output nothing else.',
  ].join('\n'),
};

function buildPrompt({ side, mode, retry }) {
  const base = BASE_PROMPTS[side] || BASE_PROMPTS.english;
  const modeHint =
    mode === 'handwriting'
      ? '这张图片是手写内容，请特别小心辨认笔画与连笔。'
      : mode === 'printed'
        ? '这张图片是印刷体或屏幕截图，请准确转写。'
        : '请先判断是印刷体还是手写体，再按对应方式仔细识别。';
  // 手写体优先时，明确要求不要漏行
  const handHint = mode === 'handwriting' ? '\n注意：不要漏掉任何一行或被涂改划掉后重写的内容。' : '';
  const retryHint = retry
    ? '\n重要：上一次识别结果不理想。请重新逐行仔细看一遍图片，逐字确认，不要遗漏、不要臆造。'
    : '';
  return base + '\n' + modeHint + handHint + retryHint;
}

function describeVisionError(error) {
  const msg = String(error?.message || error || '');
  if (/does not support image|image input|multimodal|vision|content.*type|invalid.*content|不支持|图片/i.test(msg) && /400|422|invalid|support|不支持/i.test(msg)) {
    return '当前模型不支持图片输入。请在「AI 设置」里把「视觉模型」改为支持图片的模型（例如 deepseek-v4-flash-vision-exp），或改用支持视觉的接口。原始错误：' + msg.slice(0, 200);
  }
  return msg;
}

async function callVision({ dataUrl, prompt, vision }) {
  const url = String(vision.baseUrl || '').replace(/\/+$/, '') + '/chat/completions';
  const headers = { 'Content-Type': 'application/json' };
  if (vision.apiKey) headers['Authorization'] = 'Bearer ' + vision.apiKey;
  const body = {
    model: vision.model,
    temperature: 0,
    max_tokens: 8000,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: prompt },
          { type: 'image_url', image_url: { url: dataUrl } },
        ],
      },
    ],
  };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), VISION_TIMEOUT_MS);
  let r;
  try {
    r = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: controller.signal });
  } catch (e) {
    if (e?.name === 'AbortError') throw new Error('视觉模型请求超时（' + Math.round(VISION_TIMEOUT_MS / 1000) + '秒），请重试或换更小的图片');
    throw new Error('无法连接视觉模型接口: ' + e.message);
  } finally {
    clearTimeout(timer);
  }
  if (!r.ok) {
    const t = await r.text();
    throw new Error('视觉模型接口错误 ' + r.status + ': ' + t.slice(0, 400));
  }
  const data = await r.json();
  const content = data?.choices?.[0]?.message?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((c) => (typeof c === 'string' ? c : c?.text || '')).join('');
  return '';
}

/**
 * 识别一张图片。
 * @param {{ image: string, side?: 'chinese'|'english', mode?: 'auto'|'handwriting'|'printed', vision: { baseUrl: string, model: string, apiKey: string } }} opts
 * @returns {Promise<{ text: string, engine: string, model: string, quality: object, garbled?: boolean, attempts: string[] }>}
 */
export async function recognizeImage({ image, side = 'english', mode = 'auto', vision }) {
  const { mime } = decodeImage(image);
  const dataUrl = image.startsWith('data:') ? image : 'data:' + mime + ';base64,' + image;
  const attempts = [];
  let last = null;

  for (let i = 0; i < 2; i += 1) {
    const prompt = buildPrompt({ side, mode, retry: i > 0 });
    try {
      const raw = await callVision({ dataUrl, prompt, vision });
      const text = tidyOcrText(raw);
      const quality = textQuality(text);
      if (text && !quality.garbled) {
        return { text, engine: 'vision', model: vision.model, quality, attempts };
      }
      last = { text, quality };
      attempts.push('vision: 结果可疑（字数 ' + quality.len + '，乱码率 ' + quality.badRatio.toFixed(2) + '）');
    } catch (e) {
      attempts.push('vision: ' + (e?.message || e));
      if (i === 1) throw new Error(describeVisionError(e));
    }
  }

  // 两次都不理想：如果至少有文字，就带 garbled 标记返回，让用户自行核对
  if (last && last.text) {
    return { text: last.text, engine: 'vision', model: vision.model, quality: last.quality, garbled: true, attempts };
  }
  throw new Error('识别失败：' + attempts.join('；'));
}

export { buildPrompt };
