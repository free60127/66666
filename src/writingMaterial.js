/** Recover readable structure from PDF text without changing the source sent to the model. */
const typography = (text) => text.replace(/([,;:!?])(?=[A-Za-z])/g, '$1 ').replace(/([a-z]\.)(?=[A-Z][a-z])/g, '$1 ');
const bullet = /^[•●·]\s*|^\d+[.)]\s+/;
const sentenceEnd = /[.!?]["'”’)]?$/;

function paragraphs(raw) {
  const lines = raw.replace(/\r\n?/g, '\n').split('\n');
  const blocks = [];
  let current = '';
  const flush = () => { if (current) blocks.push(typography(current)); current = ''; };
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) { flush(); continue; }
    if (current && (bullet.test(line) || (sentenceEnd.test(current) && /^[A-Z“"•●·]/.test(line)))) flush();
    current = current ? current + (current.endsWith('-') ? '' : ' ') + line : line;
  }
  flush();
  return blocks;
}

function section(raw, label = '') {
  const lines = raw.trim().split('\n');
  const first = lines[0]?.trim() || '';
  // A wrapped first sentence is body text; a short standalone title stays distinct.
  const hasTitle = lines.length > 1 && first.length < 120 && !/[.,;:]$/.test(first)
    && !/[.!?]["'”’]?[ \t]*[A-Z][a-z]/.test(first)
    && (Boolean(label) || lines[1].length > Math.max(80, first.length * 2));
  return { label, title: hasTitle ? typography(lines.shift().trim()) : '', paragraphs: paragraphs(lines.join('\n')) };
}

export function splitWritingMaterial(text) {
  const raw = String(text || '').replace(/\r\n?/g, '\n').trim();
  if (!raw) return [];
  const markers = [...raw.matchAll(/\bExcerpt[ \t]+(\d+)\b[ \t]*[:：]?[ \t]*/gi)];
  if (!markers.length) return [section(raw)];
  const parts = [];
  const preface = raw.slice(0, markers[0].index).trim();
  if (preface) parts.push(section(preface));
  for (let index = 0; index < markers.length; index += 1) {
    const marker = markers[index];
    parts.push(section(raw.slice(marker.index + marker[0].length, markers[index + 1]?.index ?? raw.length), 'Excerpt ' + marker[1]));
  }
  return parts;
}

export function formatWritingMaterialText(text) {
  return splitWritingMaterial(text).map((part) => [part.label, part.title, ...part.paragraphs].filter(Boolean).join('\n\n')).join('\n\n');
}
