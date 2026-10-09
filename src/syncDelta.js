/** Incremental snapshot protocol shared by the browser and server. */
export const SNAPSHOT_FIELDS = ['libraries', 'favorites', 'history', 'deletedHistory',
  'deletedLibraries', 'deletedLessons', 'deletedFavorites', 'progress', 'days'];
const blocked = new Set(['__proto__', 'prototype', 'constructor']);
const object = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const clone = (v) => JSON.parse(JSON.stringify(v));
export const snapshotData = (v = {}) => Object.fromEntries(SNAPSHOT_FIELDS.map((key) => [key, v[key] ?? (key === 'progress' ? {} : [])]));

export function diffSnapshot(before, after) {
  const ops = [];
  const visit = (a, b, path) => {
    if (JSON.stringify(a) === JSON.stringify(b)) return;
    if (Array.isArray(a) && Array.isArray(b)) {
      if (a.length === b.length) {
        a.forEach((value, index) => visit(value, b[index], [...path, index]));
      } else {
        let start = 0; let end = 0;
        while (start < Math.min(a.length, b.length) && JSON.stringify(a[start]) === JSON.stringify(b[start])) start += 1;
        while (end < Math.min(a.length, b.length) - start && JSON.stringify(a[a.length - 1 - end]) === JSON.stringify(b[b.length - 1 - end])) end += 1;
        ops.push({ op: 'splice', path, index: start, deleteCount: a.length - start - end, items: b.slice(start, b.length - end) });
      }
    } else if (object(a) && object(b)) {
      for (const key of Object.keys(a)) if (!Object.hasOwn(b, key)) ops.push({ op: 'remove', path: [...path, key] });
      for (const key of Object.keys(b)) {
        if (!Object.hasOwn(a, key)) ops.push({ op: 'set', path: [...path, key], value: b[key] });
        else visit(a[key], b[key], [...path, key]);
      }
    } else ops.push({ op: 'set', path, value: b });
  };
  visit(snapshotData(before), snapshotData(after), []);
  if (ops.length > 12000) return SNAPSHOT_FIELDS.filter((key) => JSON.stringify(before?.[key]) !== JSON.stringify(after?.[key]))
    .map((key) => ({ op: 'set', path: [key], value: snapshotData(after)[key] }));
  return ops;
}

export function applySnapshotPatch(before, ops) {
  if (!Array.isArray(ops) || ops.length > 12000) throw new Error('增量操作数量不正确');
  const next = clone(snapshotData(before));
  for (const change of ops) {
    if (!change || !['set', 'remove', 'splice'].includes(change.op) || !Array.isArray(change.path)
      || !change.path.length || change.path.length > 12 || !SNAPSHOT_FIELDS.includes(change.path[0])) throw new Error('增量操作路径不正确');
    for (const key of change.path) {
      if (!(typeof key === 'string' && key.length <= 200 && !blocked.has(key))
        && !(Number.isSafeInteger(key) && key >= 0)) throw new Error('增量操作路径不正确');
    }
    let target = next;
    const checkKey = (parent, key) => {
      if (Array.isArray(parent)) {
        if (!Number.isSafeInteger(key) || key < 0 || key >= parent.length) throw new Error('增量数组下标不正确');
      } else if (!object(parent) || typeof key !== 'string') throw new Error('增量对象路径不正确');
    };
    for (const key of change.path.slice(0, -1)) {
      checkKey(target, key);
      if (!Object.hasOwn(target, key)) throw new Error('增量路径不存在');
      target = target[key];
    }
    const key = change.path.at(-1);
    checkKey(target, key);
    if (change.op === 'splice') {
      const arr = target[key];
      if (!Array.isArray(arr) || !Array.isArray(change.items) || !Number.isSafeInteger(change.index)
        || !Number.isSafeInteger(change.deleteCount) || change.index < 0 || change.index > arr.length
        || change.deleteCount < 0 || change.deleteCount > arr.length - change.index) throw new Error('增量数组操作不正确');
      const items = clone(change.items);
      target[key] = [...arr.slice(0, change.index), ...items, ...arr.slice(change.index + change.deleteCount)];
    } else if (change.op === 'remove') {
      if (Array.isArray(target) || change.path.length === 1) throw new Error('增量删除操作不正确');
      delete target[key];
    } else {
      if (!Object.hasOwn(change, 'value')) throw new Error('增量操作缺少内容');
      target[key] = clone(change.value);
    }
  }
  return next;
}

export function materializeDocument(doc) {
  if (!doc?.deltaFormat) return doc;
  if (doc.deltaFormat !== 1 || typeof doc.baseRaw !== 'string' || !Array.isArray(doc.frames)) throw new Error('云端增量记录损坏');
  const base = JSON.parse(doc.baseRaw);
  let data = base.data;
  let version = base.version || 0;
  for (const frame of doc.frames) {
    if (frame.version !== version + 1) throw new Error('云端增量版本不连续');
    data = applySnapshotPatch(data, JSON.parse(frame.opsRaw));
    version = frame.version;
  }
  if (version !== doc.version) throw new Error('云端增量版本不正确');
  return { ...base, version, updatedAt: doc.updatedAt, device: doc.device, data };
}
