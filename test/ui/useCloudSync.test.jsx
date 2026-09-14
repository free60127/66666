/**
 * useCloudSync 的数据安全单测：**同步进行中的本地写入不能被合并结果覆盖**。
 *
 * 为什么必须有：这是一条真实的丢数据路径，而且用户完全看不见过程 ——
 * 挂载时那次同步跑在首次渲染的闭包里，冷启动时可能要等 30-90 秒；这期间用户
 * 收藏一条 / 存一篇课文，同步返回后写回的是"发起那一刻的快照"，新内容就从内存和
 * localStorage 里一起消失了。原来的测试全在测纯函数 mergeSnapshot，
 * 没人测过"await 期间本地又写了一次"这个时序。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import React, { useState } from 'react';
import { render, screen, act, cleanup } from '@testing-library/react';

// 只替换网络与存储入口，合并逻辑用真实的（要测的就是它被正确地用了第二次）
vi.mock('../../src/sync.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    syncOnce: vi.fn(),
    loadSyncCode: () => 'a'.repeat(32),
    loadSyncMeta: () => ({}),
    saveSyncCode: vi.fn(),
    saveSyncMeta: vi.fn(),
    createNewSyncCode: vi.fn(),
  };
});

import { syncOnce } from '../../src/sync.js';
import { useCloudSync } from '../../src/hooks/useCloudSync.js';

let api = null;

/** 复刻 App 的用法：local 是当前 state，applyMerged 把合并结果写回 state */
function Harness() {
  const [favorites, setFavorites] = useState([{ id: 'a', title: 'A' }]);
  const [libraries, setLibraries] = useState([]);
  const local = { libraries, favorites, history: [] };
  const applyMerged = (merged) => {
    setLibraries(merged.libraries || []);
    setFavorites(merged.favorites || []);
    return true;
  };
  const sync = useCloudSync({ local, applyMerged, flash: () => {} });
  api = { sync, addFavorite: (f) => setFavorites((prev) => [...prev, f]) };
  return <div data-testid="favs">{favorites.map((f) => f.id).join(',')}</div>;
}

/** 云端快照：只有 a（用户在执行同步之后才加的 b 不在里面） */
const remoteSnapshot = {
  libraries: [], favorites: [{ id: 'a', title: 'A' }], history: [], deletedHistory: [], progress: {}, days: [],
};

beforeEach(() => { cleanup(); api = null; vi.clearAllMocks(); });

describe('useCloudSync：同步期间的本地写入', () => {
  it('await 期间新收藏的一条，在写回后仍然存在（不被合并快照覆盖）', async () => {
    // 手动控制 syncOnce 何时返回 —— 这就是"请求在飞"的窗口
    let release;
    syncOnce.mockImplementation(() => new Promise((resolve) => { release = resolve; }));

    render(<Harness />);
    expect(screen.getByTestId('favs').textContent).toBe('a');

    // 发起同步（不 await，让它挂在网络里）
    let running;
    act(() => { running = api.sync.runSync(true); });

    // 请求还没回来，用户收藏了一条新的
    act(() => { api.addFavorite({ id: 'b', title: 'B' }); });
    expect(screen.getByTestId('favs').textContent).toBe('a,b');

    // 云端返回（快照里没有 b）
    await act(async () => { release({ ok: true, version: 2, merged: remoteSnapshot, added: {} }); await running; });

    expect(screen.getByTestId('favs').textContent).toBe('a,b');
  });

  it('云端新增的内容照常并进来（二次合并没有把远端丢掉）', async () => {
    syncOnce.mockResolvedValue({
      ok: true, version: 2, added: {},
      merged: { ...remoteSnapshot, favorites: [{ id: 'a', title: 'A' }, { id: 'c', title: 'C' }] },
    });
    render(<Harness />);
    await act(async () => { await api.sync.runSync(true); });
    // 顺序由 mergeFavorites 决定（远端新增在前），这里只关心两条都在
    expect(screen.getByTestId('favs').textContent.split(',').sort()).toEqual(['a', 'c']);
  });
});
