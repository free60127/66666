/** 登录账号后自动同步；登录前数据仅在本机保存。 */
import { useEffect, useRef, useState } from 'react';
import { loadSyncCode, loadSyncMeta, mergeSnapshot, saveSyncCode, saveSyncMeta, syncOnce } from '../sync.js';
import { migrateAccountData } from '../api.js';
import { loadAccount } from '../account.js';

export function useCloudSync({ account, local, applyMerged, readLocal, flash }) {
  const token = account?.token || '';
  const [syncMeta, setSyncMeta] = useState(loadSyncMeta);
  const [syncBusy, setSyncBusy] = useState(false);
  const [syncTip, setSyncTip] = useState('');
  const [legacyPending, setLegacyPending] = useState(false);
  const [codeInput, setCodeInput] = useState('');
  const busyRef = useRef(false);
  const rerunRef = useRef(false);
  const mountedRef = useRef(true);
  const lastSyncRef = useRef(0);
  const baselineRef = useRef(null);
  const runRef = useRef(null);
  const localRef = useRef(local); localRef.current = local;
  const applyRef = useRef(applyMerged); applyRef.current = applyMerged;
  // 读「落盘后的最新本机数据」：请求期间完成的写入（如批改轮询 addToHistory）是
  // 同步写 localStorage 的，但 React 状态可能还没 flush —— 用渲染期快照合并会把这些
  // 记录在内存、磁盘、云端三处同时覆盖掉（丢刚完成的练习记录）。
  const readLocalRef = useRef(readLocal); readLocalRef.current = readLocal;
  const flashRef = useRef(flash); flashRef.current = flash;
  // 「有条目过大、无法云同步」只提示一次：反复弹只会变成背景噪音
  const oversizeWarnedRef = useRef(false);
  useEffect(() => { mountedRef.current = true; return () => { mountedRef.current = false; }; }, []);
  const stillCurrent = () => mountedRef.current && loadAccount()?.token === token;

  const runSync = async (manual = true) => {
    if (!token) { if (manual) setSyncTip('登录账号后即可自动保存和恢复学习数据'); return { ok: false }; }
    if (busyRef.current) { rerunRef.current = true; return { ok: false, error: '正在同步中' }; }
    busyRef.current = true; setSyncBusy(true);
    if (manual) setSyncTip('正在同步…');
    try {
      const legacyCode = loadSyncCode();
      if (legacyCode) {
        try {
          await migrateAccountData(token, legacyCode);
          if (!stillCurrent()) return { ok: false };
          saveSyncCode('');
          flashRef.current('旧云端数据已迁入账号，以后登录即可恢复', 5000);
        } catch (error) {
          if (!stillCurrent()) return { ok: false };
          if (error.status === 404) {
            saveSyncCode('');
            flashRef.current('旧云端快照不存在，本机数据将保存到账号', 5000);
          } else { setLegacyPending(true); throw error; }
        }
      }
      const res = await syncOnce({ token, local: localRef.current, baseline: baselineRef.current });
      if (!stillCurrent()) return { ok: false };
      if (!res.ok) { setSyncTip(res.error || '同步失败'); return res; }
      baselineRef.current = res.baseline;
      setLegacyPending(Boolean(res.legacyPending));
      // 请求期间新产生的本机写入仍需保留。以「磁盘上的最新数据」为准做合并：
      // 各写入路径都是同步落盘的，读盘能拿到尚未 flush 的 React 状态更新；
      // 写回时 settled ⊇ 本机新记录，排队中的 setState 被覆盖也不会丢数据。
      const fresh = (typeof readLocalRef.current === 'function' ? readLocalRef.current() : null) || localRef.current;
      const settled = mergeSnapshot(fresh, res.merged);
      const changed = applyRef.current(settled);
      if ((res.dropped?.favorites || res.dropped?.history) && !oversizeWarnedRef.current) {
        oversizeWarnedRef.current = true;
        const parts = [];
        if (res.dropped.favorites) parts.push(res.dropped.favorites + ' 条收藏');
        if (res.dropped.history) parts.push(res.dropped.history + ' 条历史');
        flashRef.current('注意：' + parts.join('和') + '内容过大，无法同步到云端（本机保留，可导出备份留存）', 8000);
      }
      lastSyncRef.current = Date.now();
      const meta = { ...loadSyncMeta(), lastSyncAt: lastSyncRef.current, version: res.version };
      saveSyncMeta(meta); setSyncMeta(meta);
      // 自动同步成功也要清掉上一轮挂着的错误提示，否则旧报错一直误导用户
      if (manual) setSyncTip('同步完成，学习数据已保存到账号');
      else setSyncTip('');
      if (!manual && changed) flashRef.current('已恢复账号中的学习数据', 3200);
      return { ok: true };
    } catch (error) {
      if (stillCurrent()) setSyncTip('同步未完成：' + error.message);
      return { ok: false, error: error.message };
    } finally {
      busyRef.current = false;
      if (mountedRef.current) setSyncBusy(false);
      if (rerunRef.current && stillCurrent()) {
        rerunRef.current = false;
        setTimeout(() => { if (stillCurrent()) void runRef.current(false); }, 300);
      }
    }
  };
  runRef.current = runSync;
  useEffect(() => {
    if (token) void runRef.current(false);
  }, [token]);
  useEffect(() => {
    if (!token) return undefined;
    const refresh = () => {
      if (document.visibilityState === 'visible' && Date.now() - lastSyncRef.current > 5000) void runRef.current(false);
    };
    window.addEventListener('focus', refresh); document.addEventListener('visibilitychange', refresh);
    return () => { window.removeEventListener('focus', refresh); document.removeEventListener('visibilitychange', refresh); };
  }, [token]);
  useEffect(() => {
    if (!token) return undefined;
    // 不跳过刚同步后的修改；网络请求期间新增的内容也会在这一轮防抖中保存。
    const timer = setTimeout(() => { void runRef.current(false); }, 2500);
    return () => clearTimeout(timer);
  }, [token, local.libraries, local.favorites, local.history, local.deletedHistory, local.deletedLibraries,
    local.deletedLessons, local.deletedFavorites, local.progress, local.days]);

  const importLegacy = async () => {
    if (!token || !codeInput.trim() || busyRef.current) return;
    setSyncBusy(true); busyRef.current = true;
    try {
      await migrateAccountData(token, codeInput.trim().toLowerCase());
      if (!stillCurrent()) return;
      baselineRef.current = null;
      saveSyncCode(''); setCodeInput(''); setLegacyPending(false);
      busyRef.current = false;
      await runRef.current(true);
    } catch (error) { if (stillCurrent()) setSyncTip('旧数据导入失败：' + error.message); }
    finally { busyRef.current = false; if (mountedRef.current) setSyncBusy(false); }
  };
  const flushSync = async () => {
    // 最多等 8 秒：在途同步卡住（网络半死不活）时不能把「退出登录」整个挂起一分钟以上
    const deadline = Date.now() + 8000;
    while (busyRef.current && mountedRef.current && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 100));
    return mountedRef.current ? runRef.current(true) : { ok: false };
  };
  return { syncMeta, syncBusy, syncTip, legacyPending, codeInput, setCodeInput, runSync, importLegacy, flushSync };
}
