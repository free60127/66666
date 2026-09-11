/**
 * 自建课文库。
 *
 * 用户可以把自己的作业（标题 + 中文提示 + 英文原文）存成"课文"，之后像内置语料一样
 * 从侧栏选出来反复练习。只存本机 localStorage，不需要后端。
 *
 * 课文条目结构与 /api/lessons 返回的一致（book/lesson/title_en/title_cn/chinese/english），
 * 这样 selectLesson 的展示逻辑（lessonLabel 等）可以直接复用。
 */

const KEY = 'bt-lesson-libraries';

/** 规整单个库（导入的数据也要过这一关）；结构不合法返回 null。 */
export function sanitizeLibrary(raw) {
  if (!raw || typeof raw.id !== 'string' || !Array.isArray(raw.lessons)) return null;
  return {
    id: raw.id,
    name: String(raw.name || '未命名库'),
    createdAt: Number(raw.createdAt) || Date.now(),
    lessons: raw.lessons
      .filter((l) => l && typeof l === 'object')
      .map((l) => ({
        book: 'my',
        lesson: Number(l.lesson) || 1,
        title_cn: String(l.title_cn || ''),
        title_en: String(l.title_en || ''),
        chinese: String(l.chinese || ''),
        english: String(l.english || ''),
        source: String(l.source || '自建'),
        createdAt: Number(l.createdAt) || Date.now(),
      }))
      .sort((a, b) => a.lesson - b.lesson),
  };
}

/** 读取全部课文库；数据损坏时返回空数组而不是抛错。 */
export function loadLibraries() {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || '[]');
    if (!Array.isArray(raw)) return [];
    return raw.map(sanitizeLibrary).filter(Boolean);
  } catch {
    return [];
  }
}

/** 写回全部课文库；返回 false 表示本机存储写入失败（例如配额已满）。 */
export function saveLibraries(list) {
  try {
    localStorage.setItem(KEY, JSON.stringify(list));
    return true;
  } catch {
    return false;
  }
}

export function newLibraryId() {
  return 'lib-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

/** 新建一个空库，返回新列表。 */
export function createLibrary(list, name) {
  const clean = String(name || '').trim() || '我的课文库';
  return [...list, { id: newLibraryId(), name: clean, createdAt: Date.now(), lessons: [] }];
}

export function removeLibrary(list, libId) {
  return list.filter((lib) => lib.id !== libId);
}

/**
 * 把一篇作业存进指定库。
 * 同一份作业（标题 + 中文提示相同）重复保存时覆盖原条目，不产生重复课文。
 * @returns {{list: Array, lesson: object, replaced: boolean}}
 */
export function upsertLesson(list, libId, entry) {
  const titleCn = String(entry.title_cn || '').trim() || '未命名作业';
  const chinese = String(entry.chinese || '').trim();
  const english = String(entry.english || '').trim();
  let replaced = false;
  const next = list.map((lib) => {
    if (lib.id !== libId) return lib;
    const dup = lib.lessons.find((l) => l.title_cn === titleCn && l.chinese === chinese);
    if (dup) {
      replaced = true;
      return {
        ...lib,
        lessons: lib.lessons.map((l) =>
          l === dup ? { ...l, title_cn: titleCn, chinese, english: english || l.english, createdAt: Date.now() } : l,
        ),
      };
    }
    const nextNo = lib.lessons.reduce((max, l) => Math.max(max, Number(l.lesson) || 0), 0) + 1;
    const lesson = { book: 'my', lesson: nextNo, title_cn: titleCn, title_en: '', chinese, english, source: '自建', createdAt: Date.now() };
    return { ...lib, lessons: [...lib.lessons, lesson].sort((a, b) => a.lesson - b.lesson) };
  });
  const lib = next.find((l) => l.id === libId);
  const lesson = lib ? lib.lessons.find((l) => l.title_cn === titleCn && l.chinese === chinese) : null;
  return { list: next, lesson, replaced };
}

/** 从库里删掉一节课。 */
export function removeLesson(list, libId, lessonNo) {
  return list.map((lib) =>
    lib.id === libId ? { ...lib, lessons: lib.lessons.filter((l) => l.lesson !== Number(lessonNo)) } : lib,
  );
}

/**
 * 合并导入的课文库：同 id 的库并入（课文按 标题+中文 去重），
 * 新 id 的库整体追加（重名时加「（导入）」后缀，不覆盖现有库）。
 * @returns {{list: Array, libsAdded: number, lessonsAdded: number}}
 */
export function mergeLibraries(current, incoming) {
  let list = [...(Array.isArray(current) ? current : [])];
  let libsAdded = 0;
  let lessonsAdded = 0;
  for (const raw of Array.isArray(incoming) ? incoming : []) {
    const clean = sanitizeLibrary(raw);
    if (!clean) continue;
    const exists = list.find((l) => l.id === clean.id);
    if (exists) {
      for (const lesson of clean.lessons) {
        const r = upsertLesson(list, clean.id, lesson);
        list = r.list;
        if (!r.replaced) lessonsAdded += 1;
      }
    } else {
      const name = list.some((l) => l.name === clean.name) ? clean.name + '（导入）' : clean.name;
      list = [...list, { ...clean, name }];
      libsAdded += 1;
      lessonsAdded += clean.lessons.length;
    }
  }
  return { list, libsAdded, lessonsAdded };
}
