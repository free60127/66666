import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../../src/api.js', () => ({ readAccountChanges: vi.fn(), patchAccountData: vi.fn() }));
import { readAccountChanges, patchAccountData } from '../../src/api.js';
import { syncOnce } from '../../src/sync.js';
import { applySnapshotPatch, diffSnapshot, snapshotData } from '../../src/syncDelta.js';
import { mergeSnapshot } from '../../src/syncMerge.js';
import { renameLesson } from '../../src/lessonLibrary.js';

let data; let version; let frames;
const copy = (x) => structuredClone(x);
const seed = () => snapshotData({ libraries: [{ id: 'lib', name: '测试课文库', createdAt: 1, sections: ['一组', '空组'], sectionsUpdatedAt: 1,
  lessons: [{ book: 'my', lid: 'lsn', lesson: 1, title_cn: '旧标题', title_en: '', section: '一组',
    chinese: '中文'.repeat(10000), english: 'English'.repeat(10000), source: '自建', createdAt: 1 }] }],
  history: Array.from({ length: 80 }, (_, i) => ({ jobId: 'j-' + (79 - i), time: 79 - i })) });
beforeEach(() => {
  vi.clearAllMocks(); localStorage.clear(); data = seed(); version = 1; frames = [];
  readAccountChanges.mockImplementation(async (_token, since) => since < 1 ? { mode: 'full', version, data: copy(data) }
    : { mode: 'delta', version, changes: copy(frames.filter((f) => f.version > since)) });
  patchAccountData.mockImplementation(async (_token, body) => {
    if (body.baseVersion !== version) return { ok: false, status: 409, data: { version } };
    data = applySnapshotPatch(data, body.ops); version += 1;
    frames.push({ version, ops: copy(body.ops) });
    return { ok: true, status: 200, data: { version, ops: copy(body.ops) } };
  });
});
describe('incremental account sync', () => {
  it('restores once, then skips unchanged writes and never truncates 80 archived jobs', async () => {
    const a = await syncOnce({ token: 'a', local: mergeSnapshot(data, data) });
    expect(a.ok).toBe(true); expect(a.merged.history).toHaveLength(20);
    expect(patchAccountData).not.toHaveBeenCalled();
    const b = await syncOnce({ token: 'a', local: a.merged, baseline: a.baseline });
    expect(readAccountChanges).toHaveBeenLastCalledWith('a', 1);
    expect(patchAccountData).not.toHaveBeenCalled(); expect(b.baseline.data.history).toHaveLength(80);
  });
  it('sends only the new progress entry, without unchanged lesson text', async () => {
    const a = await syncOnce({ token: 'a', local: data });
    const local = { ...a.merged, progress: { '10|1': { n: 1, best: 90, last: 90, at: 2, ms: 20 } } };
    const b = await syncOnce({ token: 'a', local, baseline: a.baseline });
    expect(b.ok).toBe(true);
    const body = patchAccountData.mock.calls[0][1];
    expect(JSON.stringify(body).length).toBeLessThan(400);
    expect(JSON.stringify(body)).not.toContain('English');
    expect(b.baseline.data.progress['10|1'].n).toBe(1);
  });
  it('a second device receives only changes, retaining its other offline progress', async () => {
    const a = await syncOnce({ token: 'a', local: data });
    const b = await syncOnce({ token: 'a', local: data });
    await syncOnce({ token: 'a', local: { ...a.merged, progress: { '10|1': { n: 1, best: 90, last: 90, at: 2, ms: 20 } } }, baseline: a.baseline });
    const result = await syncOnce({ token: 'a', local: { ...b.merged, progress: { '10|2': { n: 1, best: 80, last: 80, at: 3, ms: 20 } } }, baseline: b.baseline });
    expect(Object.keys(result.merged.progress).sort()).toEqual(['10|1', '10|2']);
    expect(JSON.stringify(patchAccountData.mock.calls.at(-1)[1])).not.toContain('English');
  });
  it('retries a concurrent update without losing either device data', async () => {
    const a = await syncOnce({ token: 'a', local: data });
    const save = patchAccountData.getMockImplementation();
    patchAccountData.mockImplementationOnce(async (_token, _body) => {
      const ops = [{ op: 'set', path: ['progress', '10|2'], value: { n: 1, best: 80, last: 80, at: 3, ms: 20 } }];
      data = applySnapshotPatch(data, ops); version += 1; frames.push({ version, ops });
      return { ok: false, status: 409, data: { version } };
    }).mockImplementation(save);
    const result = await syncOnce({ token: 'a', local: { ...a.merged, progress: { '10|1': { n: 1, best: 90, last: 90, at: 2, ms: 20 } } }, baseline: a.baseline });
    expect(result.ok).toBe(true); expect(Object.keys(data.progress)).toHaveLength(2);
  });
  it('lesson edits survive the old remote copy, and deletions never resurrect on another device', async () => {
    const a = await syncOnce({ token: 'a', local: data });
    const b = await syncOnce({ token: 'a', local: data });
    const libraries = renameLesson(a.merged.libraries, 'lib', 'lsn', { title_cn: '新标题', title_en: 'New title' });
    const edited = await syncOnce({ token: 'a', local: { ...a.merged, libraries }, baseline: a.baseline });
    expect(edited.merged.libraries[0].lessons[0].title_cn).toBe('新标题');
    expect(JSON.stringify(patchAccountData.mock.calls.at(-1)[1]).length).toBeLessThan(700);
    const restored = await syncOnce({ token: 'a', local: b.merged, baseline: b.baseline });
    expect(restored.merged.libraries[0].lessons[0].title_cn).toBe('新标题');
    const deleted = await syncOnce({ token: 'a', local: { ...edited.merged, deletedLessons: ['lib|lsn'],
      libraries: [{ ...edited.merged.libraries[0], lessons: [] }] }, baseline: edited.baseline });
    const stale = await syncOnce({ token: 'a', local: restored.merged, baseline: restored.baseline });
    expect(deleted.ok).toBe(true); expect(stale.merged.libraries[0].lessons).toHaveLength(0);
  });
  it('ignores a different account baseline and restores after journal compaction', async () => {
    const a = await syncOnce({ token: 'a', local: data });
    await syncOnce({ token: 'b', local: snapshotData(), baseline: a.baseline });
    expect(readAccountChanges).toHaveBeenLastCalledWith('b', -1);
    readAccountChanges.mockResolvedValueOnce({ mode: 'full', version: 10, data: copy(data) });
    const result = await syncOnce({ token: 'a', local: a.merged, baseline: a.baseline });
    expect(result.ok).toBe(true); expect(result.version).toBe(10);
  });
  it('rejects prototype paths and preserves empty JSON arrays', () => {
    expect(() => applySnapshotPatch(data, [{ op: 'set', path: ['progress', '__proto__'], value: {} }])).toThrow();
    const changed = { ...data, days: ['2026-10-09'] };
    expect(applySnapshotPatch(changed, diffSnapshot(changed, data)).days).toEqual([]);
  });
});
