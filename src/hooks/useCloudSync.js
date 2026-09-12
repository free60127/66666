/**
 * 云同步（同步码）：把本机的课文库 / 收藏 / 历史与云端那份合并。
 *
 * 抽出来的原因：这块是**一整套独立的状态机** —— 同步码、进行中标记、提示文案、已同步时间、
 * 「云端没有这串码」的降级、三条自动同步触发（挂载 / 回到前台 / 数据变化后防抖推送），
 * 全都和编辑逻辑无关，却在 App 里占了 140 行、还借用了 App 的 20 多个变量。
 *
 * 边界：本机数据由调用方通过 `local` 传进来、合并结果通过 `applyMerged` 写回，
 * 这里只负责"跟云端对齐"这件事。
 */
import { useEffect, useRef, useState } from 'react';
import { createNewSyncCode, loadSyncCode, loadSyncMeta, saveSyncCode, saveSyncMeta, syncOnce } from '../sync.js';
import { pullCloudSync } from '../api.js';

export function useCloudSync({ local, applyMerged, flash }) {
  const [syncCode, setSyncCode] = useState(loadSyncCode);
  const [syncMeta, setSyncMeta] = useState(loadSyncMeta);
  const [syncBusy, setSyncBusy] = useState(false);
  const [syncTip, setSyncTip] = useState('');
  const [codeInput, setCodeInput] = useState('');
  const [syncLost, setSyncLost] = useState(false); // 云端没有这串码的数据（通常是平台重新部署）
  const syncBusyRef = useRef(false);
  const lastSyncAtRef = useRef(0);
  // 最近一次"手动操作"（生成码/换码/填码/停用/立即同步）的时间：
  // 自动同步在这之后 5 秒内不跑，否则它会把手动操作刚给出的提示覆盖掉（用户就看不到失败原因了）
  const manualActionAtRef = useRef(0);

  // runSync 的闭包里带着本机数据的快照；「回到前台同步」的监听只在 syncCode 变化时重建，
  // 直接捕获 runSync 会拿着**过期数据**去合并 —— 统一走 ref 取最新那一次渲染的函数与数据。
  const localRef = useRef(local);
  localRef.current = local;

  const runSync = async (manual = true, codeOverride) => {
    const code = codeOverride || syncCode;
    if (!code) { if (manual) setSyncTip('还没有同步码：先生成一个，或在另一台设备上把码填进来'); return; }
    if (syncBusyRef.current) { if (manual) setSyncTip('正在同步中，请稍候再试'); return; }
    // 自动同步让位给刚发生的手动操作，避免覆盖提示 / 抢在同一时刻发请求
    if (!manual && Date.now() - manualActionAtRef.current < 5000) return;
    if (manual) manualActionAtRef.current = Date.now();
    syncBusyRef.current = true;
    setSyncBusy(true);
    if (manual) setSyncTip('正在同步…');
    try {
      const res = await syncOnce({ code, local: localRef.current });
      if (!res.ok) {
        if (res.code === 'NOT_FOUND') { setSyncLost(true); setSyncTip(res.error); }
        else setSyncTip(res.error || '同步失败');
        return;
      }
      setSyncLost(false);
      // 云端原本没有这串码（换过存储后端 / 临时磁盘被清），刚用本机数据把它重建起来了。
      // 必须明确告诉用户 —— 否则他以为还是坏的，会去点「换码」把好端端的码换掉。
      if (res.recovered) flash('云端原本没有这串同步码，已用本机数据重建；其它设备下次同步会自动恢复', 6000);
      lastSyncAtRef.current = Date.now();
      const changed = applyMerged(res.merged);
      const meta = { ...loadSyncMeta(), lastSyncAt: lastSyncAtRef.current, version: res.version };
      saveSyncMeta(meta); setSyncMeta(meta);
      const a = res.added || {};
      const gained = (a.libsAdded || 0) + (a.lessonsAdded || 0) + (a.favAdded || 0) + (a.histAdded || 0);
      if (manual) {
        setSyncTip(gained
          ? `同步完成：新增 ${a.libsAdded || 0} 个课文库、${a.lessonsAdded || 0} 篇课文、${a.favAdded || 0} 条收藏、${a.histAdded || 0} 条历史`
          : '同步完成：已是最新，没有新增内容');
      } else if (changed) {
        flash('已从云端同步到新内容', 3200);
      }
    } catch (e) {
      setSyncTip('同步失败：' + (e.message || '网络错误'));
    } finally {
      syncBusyRef.current = false;
      setSyncBusy(false);
    }
  };

  const startNewSync = async () => {
    // 正在同步时不要静默 return —— 用户会以为按钮坏了
    if (syncBusyRef.current) { setSyncTip('正在同步中，请稍候再试'); return; }
    manualActionAtRef.current = Date.now(); // 先占位，防止自动同步覆盖下面可能出现的失败提示
    syncBusyRef.current = true;
    setSyncBusy(true);
    setSyncTip('');
    try {
      const code = await createNewSyncCode();
      saveSyncCode(code); setSyncCode(code);
      syncBusyRef.current = false;
      await runSync(true, code);
    } catch (e) {
      setSyncTip('生成同步码失败：' + (e.message || '网络错误'));
    } finally {
      syncBusyRef.current = false;
      setSyncBusy(false);
    }
  };

  const useExistingCode = async () => {
    const code = codeInput.trim().toLowerCase();
    if (!/^[a-f0-9]{32}$/.test(code)) { setSyncTip('同步码应为 32 位十六进制字符，请检查是否复制完整'); return; }
    manualActionAtRef.current = Date.now();
    // 先探一次：云端不存在的码在**输入这一刻**就拦下来。
    // 这一步是"云端没有就自动重建"能成立的前提 —— 否则打错一个字符
    // 会被静默接受，新开一个空槽位，用户还以为同步成功了。
    setSyncBusy(true);
    try {
      await pullCloudSync(code);
    } catch (e) {
      setSyncBusy(false);
      if (e && e.status === 404) { setSyncTip('云端没有这串码 —— 请确认是否复制完整（32 位），以及它是不是在当前服务端生成的'); return; }
      setSyncTip('读取云端失败：' + (e.message || '网络错误'));
      return;
    }
    setSyncBusy(false);
    saveSyncCode(code); setSyncCode(code); setCodeInput('');
    await runSync(true, code);
  };

  const copySyncCode = async () => {
    try { await navigator.clipboard.writeText(syncCode); setSyncTip('同步码已复制 —— 在另一台设备的「备份 → 云同步」里粘贴即可'); }
    catch { setSyncTip('复制失败，请手动选中复制'); }
  };

  const stopSync = () => {
    if (!window.confirm('停用云同步？\n\n本机数据不受影响。云端那份数据仍在这串码下（除非服务端重新部署过），以后把这串码填回来就能继续用。')) return;
    saveSyncCode(''); setSyncCode(''); setSyncLost(false); setSyncTip('已停用云同步（本机数据保留）');
  };

  // runSync 的闭包里带着本机数据（课文库 / 收藏 / 历史）的快照。
  // 下面「回到前台同步」的监听只在 syncCode 变化时重建，若直接捕获 runSync，
  // 切回前台时会拿着**过期数据**去合并。所以统一走 ref 取最新那一次渲染的函数。
  const runSyncRef = useRef(runSync);
  useEffect(() => { runSyncRef.current = runSync; });

  // 打开页面时自动同步一次（把云端新增内容合并进来）
  useEffect(() => {
    if (syncCode) runSync(false, syncCode);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 回到前台就同步一次。
  // 手机/平板切回页面时浏览器**不会重新加载**（只是恢复原来的标签页），
  // 所以上面那个"挂载时同步"根本不会触发 —— 这是"同步好像坏了"最常见的原因：
  // 用户以为页面还开着就应该是新的。
  // 桌面端在多个标签页之间来回切，走的是同一条路径（focus）。
  useEffect(() => {
    if (!syncCode) return undefined;
    const syncIfStale = () => {
      if (document.visibilityState !== 'visible') return;   // 切到后台不请求
      if (syncBusyRef.current) return;                       // 正在同步就跳过
      if (Date.now() - lastSyncAtRef.current < 5000) return; // 刚同步过就别重复
      runSyncRef.current(false);
    };
    document.addEventListener('visibilitychange', syncIfStale);
    window.addEventListener('focus', syncIfStale);
    return () => {
      document.removeEventListener('visibilitychange', syncIfStale);
      window.removeEventListener('focus', syncIfStale);
    };
  }, [syncCode]);

  // 本机数据变化后防抖推送（刚同步完的 3 秒内不触发，避免自己触发自己）
  useEffect(() => {
    if (!syncCode) return undefined;
    if (Date.now() - lastSyncAtRef.current < 3000) return undefined;
    const t = setTimeout(() => { runSync(false); }, 8000);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [local.libraries, local.favorites, local.history, syncCode]);

  return {
    syncCode, setSyncCode, syncMeta, syncBusy, syncTip, setSyncTip,
    codeInput, setCodeInput, syncLost, setSyncLost,
    runSync, startNewSync, useExistingCode, copySyncCode, stopSync,
  };
}
