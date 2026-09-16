/**
 * 从 PDF 里抠出文字层（**零依赖**）。
 *
 * 为什么自己写：项目刻意不带 pdf.js（源码 1MB+，而这里只需要"把字抠出来"）。
 * 这个功能（错误训练里上传课文 PDF）对精度的要求也不高 —— 拿到大致文字当出题素材即可，
 * 版式、字体、颜色一概不关心。
 *
 * 能处理的：文字型 PDF（Word/LaTeX/网页打印出来的那种），含 Flate 压缩的流。
 * 处理不了的：**扫描件**（整页是图片、没有文字层）—— 这时提取结果会很少，
 * 调用方据此提示用户改用「拍照/上传图片」走视觉识别（那条链路本来就能读图）。
 *
 * 实现路线：找 `stream ... endstream` → 解压（浏览器自带 DecompressionStream）→
 * 从内容流里抽 `Tj/TJ/'/"` 的字符串字面量。不做字体/CMap 映射，
 * 所以 CJK 的 CID 字体可能出乱码 —— 对"当素材"这个用途可以接受，且只影响 PDF 这一条路。
 */

/** 内容流里的字符串字面量：`(...)`（含转义）与 `<...>`（十六进制） */
function unescapeLiteral(s) {
  let out = '';
  for (let i = 0; i < s.length; i += 1) {
    const c = s[i];
    if (c !== '\\') { out += c; continue; }
    const n = s[i + 1];
    i += 1;
    if (n === 'n') out += '\n';
    else if (n === 'r') out += '\r';
    else if (n === 't') out += '\t';
    else if (n === 'b' || n === 'f') out += ' ';
    else if (n === '\n') out += '';              // 续行
    else if (n >= '0' && n <= '7') {             // 八进制
      let oct = n;
      while (oct.length < 3 && s[i + 1] >= '0' && s[i + 1] <= '7') { oct += s[i + 1]; i += 1; }
      out += String.fromCharCode(parseInt(oct, 8) & 0xff);
    } else out += n == null ? '' : n;
  }
  return out;
}

function hexToString(hex) {
  let out = '';
  const clean = String(hex).replace(/[^0-9A-Fa-f]/g, '');
  for (let i = 0; i + 1 < clean.length; i += 2) out += String.fromCharCode(parseInt(clean.slice(i, i + 2), 16));
  return out;
}

/** JS 字符串 → 十六进制（塞回 <...> 走同一条解析路径，避免再处理一次转义） */
const toHex = (str) => Array.from(String(str), (c) => (c.charCodeAt(0) & 0xff).toString(16).padStart(2, '0')).join('');

/**
 * 从**已解压**的内容流里抽文字。
 *
 * 分两步是刻意的：`[(Hel) -20 (lo)] TJ` 这种数组里，字符串片段对"逐 token 扫描"来说
 * 和普通的 `(x) Tj` 长得一样 —— 第一版就是被它骗了：外层循环先把 `(Hel)`、`(lo)` 当成
 * 待输出的字符串收下，等扫到 `TJ` 时又拼一遍，结果同一个词被输出两次。
 * 所以**先把 `[...] TJ` 整体归一化**成一个十六进制字符串，再走单一路径。
 *
 * 导出出来是为了能脱离 PDF 外壳单测（字符串解析这一段最容易写错）。
 */
export function textFromContentStream(content) {
  let src = String(content || '');
  src = src.replace(/\[([^\]]*)\]\s*TJ/g, (_, arr) => {
    const items = String(arr).match(/\((?:\\.|[^\\()])*\)|<[0-9A-Fa-f\s]*>|-?\d+(?:\.\d+)?/g) || [];
    let line = '';
    for (const it of items) {
      if (it.startsWith('(')) line += unescapeLiteral(it.slice(1, -1));
      else if (it.startsWith('<')) line += hexToString(it.slice(1, -1));
      else if (Number(it) < -180) line += ' ';       // 明显的大字距 → 当一个空格
    }
    return '<' + toHex(line) + '>';
  });

  const parts = [];
  let pending = null;
  // ⚠️ `T*` 后面**不能**加单词边界断言（）：`*` 与后面的空格都是非单词字符，
  //    那个断言永远不成立，换行会被整段丢掉（第一版就这么错的）。
  const re = /\((?:\\.|[^\\()])*\)|<[0-9A-Fa-f\s]*>|Tj|TJ|Td|TD|T\*|ET|'|"/g;
  let m;
  while ((m = re.exec(src))) {
    const tok = m[0];
    if (tok.startsWith('(')) { pending = (pending || '') + unescapeLiteral(tok.slice(1, -1)); continue; }
    if (tok.startsWith('<')) { pending = (pending || '') + hexToString(tok.slice(1, -1)); continue; }
    if (tok === 'Tj') { if (pending) parts.push(pending); pending = null; continue; }
    if (tok === "'" || tok === '"') { if (pending) parts.push(pending); pending = null; parts.push('\n'); continue; }
    // Td / TD / T* / ET：都当成"换行"（不追求精确排版，够用就行）
    if (pending) { parts.push(pending); pending = null; }
    parts.push('\n');
  }
  if (pending) parts.push(pending);
  return parts.join('')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** 把字节流解成字符串（PDF 的流内容基本是 Latin-1 范围，二进制部分不走这里） */
const latin1 = (u8) => {
  let s = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < u8.length; i += CHUNK) s += String.fromCharCode.apply(null, u8.subarray(i, i + CHUNK));
  return s;
};

/** Flate 解压：优先用浏览器自带的 DecompressionStream（零依赖） */
async function inflate(u8) {
  if (typeof DecompressionStream === 'undefined') return null;
  try {
    const ds = new DecompressionStream('deflate');
    const stream = new Blob([u8]).stream().pipeThrough(ds);
    return new Uint8Array(await new Response(stream).arrayBuffer());
  } catch { return null; }
}

/**
 * 主入口：给 PDF 的 ArrayBuffer，返回 { text, streams, compressed }。
 * `text` 太短基本就是扫描件（调用方据此给提示）。
 */
export async function extractPdfText(arrayBuffer) {
  const bytes = new Uint8Array(arrayBuffer);
  const raw = latin1(bytes);
  const out = [];
  let streams = 0;
  let compressed = 0;
  const re = /stream\r?\n?/g;
  let m;
  while ((m = re.exec(raw))) {
    const start = m.index + m[0].length;
    const end = raw.indexOf('endstream', start);
    if (end < 0) break;
    const body = bytes.subarray(start, end);
    streams += 1;
    // 先按"未压缩"直接解析（有些 PDF 的流就是明文）；若像 Flate（以 0x78 开头）再解压
    let text = '';
    if (body[0] === 0x78) {
      const inf = await inflate(body);
      if (inf) { compressed += 1; text = textFromContentStream(latin1(inf)); }
    }
    if (!text) text = textFromContentStream(latin1(body));
    if (text) out.push(text);
    re.lastIndex = end;
  }
  const text = out.join('\n\n').replace(/\n{3,}/g, '\n\n').trim();
  return { text, streams, compressed };
}
