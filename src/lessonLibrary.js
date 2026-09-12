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
        // lid：一节课的**稳定标识**（序号可以改、可以重排，但 lid 不变）。
        // 练习记录（同课对比 / 计时器）用它做 lessonKey，所以改序号不会把历史对比弄丢。
        lid: String(l.lid || ''),
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

export function newLessonId() {
  return 'lsn-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

/** 按稳定 id 找一节课；传入数字时退回按序号找（兼容老调用） */
export function findLesson(lib, lidOrNo) {
  if (!lib || !Array.isArray(lib.lessons)) return null;
  if (typeof lidOrNo === 'string' && lidOrNo) return lib.lessons.find((l) => l.lid === lidOrNo) || null;
  return lib.lessons.find((l) => l.lesson === Number(lidOrNo)) || null;
}

/**
 * 给缺 lid 的历史数据补上稳定 id（一次性迁移，App 启动时跑）。
 * 之所以要落盘而不是"读的时候临时生成"：临时 id 每次加载都会变，
 * 练习记录就对不上了 —— 迁移只做一次，之后 id 永久固定。
 * @returns {{list: Array, changed: boolean}}
 */
export function ensureLessonIds(list) {
  let changed = false;
  const next = (Array.isArray(list) ? list : []).map((lib) => {
    const lessons = (lib.lessons || []).map((l) => {
      if (l.lid) return l;
      changed = true;
      return { ...l, lid: newLessonId() };
    });
    return changed ? { ...lib, lessons } : lib;
  });
  return { list: changed ? next : list, changed };
}

/** 只动某一节课，其余原样返回（内部工具） */
function mapLib(list, libId, fn) {
  return (Array.isArray(list) ? list : []).map((lib) => (lib.id === libId ? fn(lib) : lib));
}

/** 序号补齐成 1、2、3…（按当前顺序），返回新的列表 */
export function renumberLibrary(list, libId) {
  return mapLib(list, libId, (lib) => ({
    ...lib,
    lessons: [...lib.lessons]
      .sort((a, b) => (Number(a.lesson) || 0) - (Number(b.lesson) || 0))
      .map((l, i) => (l.lesson === i + 1 ? l : { ...l, lesson: i + 1 })),
  }));
}

/**
 * 改标题（中文 / 英文）。空标题不覆盖原值（由界面负责校验）。
 */
export function renameLesson(list, libId, lid, patch = {}) {
  const titleCn = String(patch.title_cn ?? '').trim();
  const titleEn = String(patch.title_en ?? '').trim();
  return mapLib(list, libId, (lib) => ({
    ...lib,
    lessons: lib.lessons.map((l) => (l.lid === lid
      ? { ...l, title_cn: titleCn || l.title_cn, title_en: titleEn }
      : l)),
  }));
}

/**
 * 手动改序号：把它挪到第 targetNo 位，中间的课整体顺移，最后统一补齐成 1…N。
 *
 * 为什么不是"直接改数字"：序号是列表顺序的体现，直接改成重复/跳跃的数字会让
 * 列表乱序、还会出现两节课同号（按序号选的逻辑就废了）。
 * 挪位 + 重排是唯一没有歧义的语义。
 */
export function moveLesson(list, libId, lid, targetNo) {
  const lib = (Array.isArray(list) ? list : []).find((x) => x.id === libId);
  if (!lib) return list;
  const ordered = [...lib.lessons].sort((a, b) => (Number(a.lesson) || 0) - (Number(b.lesson) || 0));
  const from = ordered.findIndex((l) => l.lid === lid);
  if (from < 0) return list;
  const want = Math.min(ordered.length, Math.max(1, Math.round(Number(targetNo) || from + 1)));
  const to = want - 1;
  // 只有在"位置和序号都没变"时才算无事发生。
  // 若列表带空档（例：2、3），用户把第一节课改成 1 —— 位置没动但序号要变，
  // 这时必须继续走下去（重排会把空档补掉），否则用户会觉得"改了没反应"。
  if (to === from && (Number(ordered[from].lesson) || 0) === want) return list;
  const moving = ordered.splice(from, 1)[0];
  ordered.splice(to, 0, moving);
  return mapLib(list, libId, (x) => ({ ...x, lessons: ordered.map((l, i) => (l.lesson === i + 1 ? l : { ...l, lesson: i + 1 })) }));
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
          // lid 保持不变：同一条课文换个标题重存，练习历史仍然认得它
          l === dup ? { ...l, title_cn: titleCn, chinese, english: english || l.english, createdAt: Date.now() } : l,
        ),
      };
    }
    const nextNo = lib.lessons.reduce((max, l) => Math.max(max, Number(l.lesson) || 0), 0) + 1;
    const lesson = {
      book: 'my',
      lid: String(entry.lid || '') || newLessonId(),
      lesson: nextNo,
      title_cn: titleCn,
      title_en: String(entry.title_en || ''),
      chinese,
      english,
      source: '自建',
      createdAt: Date.now(),
    };
    return { ...lib, lessons: [...lib.lessons, lesson].sort((a, b) => a.lesson - b.lesson) };
  });
  const lib = next.find((l) => l.id === libId);
  const lesson = lib ? lib.lessons.find((l) => l.title_cn === titleCn && l.chinese === chinese) : null;
  return { list: next, lesson, replaced };
}

/**
 * 从库里删掉一节课（按稳定 id 或序号都行）。
 * **不会自动重排序号** —— 重排会改变其它课的序号，而序号在界面上是"第几课"，
 * 用户可能正指着它；想补齐空缺请显式调用 renumberLibrary（侧栏有「重排序号」按钮）。
 */
export function removeLesson(list, libId, lidOrNo) {
  const isLid = typeof lidOrNo === 'string' && lidOrNo;
  return mapLib(list, libId, (lib) => ({
    ...lib,
    lessons: lib.lessons.filter((l) => (isLid ? l.lid !== lidOrNo : l.lesson !== Number(lidOrNo))),
  }));
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
