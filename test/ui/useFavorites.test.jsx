/**
 * useFavorites 单测（收藏 + 间隔重复复习的运行态）。
 *
 * 为什么值得测：这一层把"纯逻辑"（favorites.js，已有单测）接到了 UI 状态上，
 * 接错的地方全在边界上：重复收藏会不会变两条、取消后是否真的落盘、
 * 复习三档评分是否推进队列并写回排期（写不回去就会出现"每次都让我复习同一张卡"）。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useFavorites } from '../../src/hooks/useFavorites.js';

const flash = vi.fn();
const openFavs = vi.fn();
const closeFavs = vi.fn();

const props = () => ({
  flash, setView: vi.fn(), settings: {}, polishLevel: '四六级',
  isOpen: false, openFavs, closeFavs, lessonKey: 'lesson:2-18',
});

const item = (id) => ({
  id, kind: '错误', category: '词义', title: 'search my bag',
  from: 'search my bag', to: 'search for my bag', explanation: '搭配错误',
});

beforeEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
});

describe('useFavorites', () => {
  it('收藏 → 出现在列表并写入本机存储', () => {
    const { result } = renderHook(() => useFavorites(props()));
    act(() => result.current.toggleFavorite(item('f1')));
    expect(result.current.favorites).toHaveLength(1);
    expect(result.current.favorites[0].id).toBe('f1');
    expect(JSON.parse(localStorage.getItem('bt-favorites') || '[]')).toHaveLength(1);
    expect(flash).toHaveBeenCalledWith(expect.anything(), expect.stringContaining('已收藏'));
  });

  it('再点一次 = 取消收藏（不会留下重复条目）', () => {
    const { result } = renderHook(() => useFavorites(props()));
    act(() => result.current.toggleFavorite(item('f1')));
    act(() => result.current.toggleFavorite(item('f1')));
    expect(result.current.favorites).toHaveLength(0);
    expect(JSON.parse(localStorage.getItem('bt-favorites') || '[]')).toHaveLength(0);
  });

  it('新收藏带上了复习排期（否则永远不进复习队列）', () => {
    const { result } = renderHook(() => useFavorites(props()));
    act(() => result.current.toggleFavorite(item('f1')));
    const f = result.current.favorites[0];
    expect(f).toHaveProperty('due');
    expect(f).toHaveProperty('ease');
    expect(f).toHaveProperty('reps');
  });

  it('没有 id 的条目不会被收藏（防止脏数据进列表）', () => {
    const { result } = renderHook(() => useFavorites(props()));
    act(() => result.current.toggleFavorite({ title: '没有 id' }));
    expect(result.current.favorites).toHaveLength(0);
    act(() => result.current.toggleFavorite(null));
    expect(result.current.favorites).toHaveLength(0);
  });

  it('removeFavorite 按 id 删除并落盘', () => {
    const { result } = renderHook(() => useFavorites(props()));
    act(() => result.current.toggleFavorite(item('f1')));
    act(() => result.current.toggleFavorite(item('f2')));
    act(() => result.current.removeFavorite('f1'));
    expect(result.current.favorites.map((x) => x.id)).toEqual(['f2']);
    expect(JSON.parse(localStorage.getItem('bt-favorites') || '[]').map((x) => x.id)).toEqual(['f2']);
  });

  it('startReview：新收藏当天到期，会排进复习队列', () => {
    const { result } = renderHook(() => useFavorites(props()));
    act(() => result.current.toggleFavorite(item('f1')));
    expect(result.current.favDueCount).toBe(1);
    act(() => result.current.startReview());
    expect(result.current.favReview).not.toBeNull();
    expect(result.current.favReview.ids).toEqual(['f1']);
    expect(openFavs).toHaveBeenCalled();
  });

  it('startReview：没有到期卡片时给提示且不进入复习', () => {
    const { result } = renderHook(() => useFavorites(props()));
    act(() => result.current.startReview());
    expect(result.current.favReview).toBeNull();
    expect(flash).toHaveBeenCalledWith(expect.anything(), expect.stringContaining('没有到期'), expect.anything());
  });

  it('gradeFavReview：评分后推进队列并把新排期写回存储', () => {
    const { result } = renderHook(() => useFavorites(props()));
    act(() => result.current.toggleFavorite(item('f1')));
    act(() => result.current.toggleFavorite(item('f2')));
    act(() => result.current.startReview());
    const before = result.current.favReview.ids[0];
    act(() => result.current.gradeFavReview(2)); // 2 = good
    // 队列推进（两张卡：评完第一张后 index 前进，或直接结束）
    const r = result.current.favReview;
    const advanced = r === null || r.index >= 1 || r.ids.length < 2;
    expect(advanced).toBe(true);
    // 排期落盘：至少有一张的 reps 被推进过
    const saved = JSON.parse(localStorage.getItem('bt-favorites') || '[]');
    expect(saved.some((x) => Number(x.reps) > 0 && x.id === before)).toBe(true);
  });
});
