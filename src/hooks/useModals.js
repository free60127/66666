/**
 * 弹窗状态 + 键盘可达性（role=dialog / Esc 关闭 / 焦点陷阱）。
 *
 * 抽出来的原因：8 个弹窗的开关、3 个弹窗内的提示、以及那段"哪个弹窗在最上层"的
 * 焦点管理逻辑，全都散在 App 里 —— 加一个弹窗要在四处登记（state、优先级、closers、
 * 依赖数组）。现在只有这一处需要改。
 *
 * 注意：这里**只管开关与焦点**，弹窗的渲染仍在各自的组件里（components/modals/*）。
 */
import { useEffect, useRef, useState } from 'react';

export function useModals({ getCloseCamera, getMaterialBusy }) {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [materialOpen, setMaterialOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [favOpen, setFavOpen] = useState(false);
  const [libModalOpen, setLibModalOpen] = useState(false);
  const [newJobOpen, setNewJobOpen] = useState(false);
  const [backupOpen, setBackupOpen] = useState(false);
  const [camOpen, setCamOpen] = useState(false);
  const [lessonEdit, setLessonEdit] = useState(null); // { libId, lid, lesson }
  const [backupTip, setBackupTip] = useState('');
  const [libTip, setLibTip] = useState('');

  const modalRefs = useRef({});

  // 键盘可达性：把「哪个弹窗开着」做成一件事，Esc 关闭、Tab 只在弹窗内循环。
  // 优先级顺序 = 屏幕上的层级顺序（后打开的排前面）。
  useEffect(() => {
    const open = camOpen ? 'cam' : materialOpen ? 'material' : newJobOpen ? 'newjob' : libModalOpen ? 'lib' : lessonEdit ? 'lessonEdit' : backupOpen ? 'backup' : historyOpen ? 'history' : favOpen ? 'fav' : settingsOpen ? 'settings' : null;
    if (!open) return undefined;
    const closers = {
      cam: () => { if (getCloseCamera && getCloseCamera()) getCloseCamera()(); },
      material: () => { if (!(getMaterialBusy && getMaterialBusy())) setMaterialOpen(false); },
      newjob: () => setNewJobOpen(false),
      lib: () => setLibModalOpen(false),
      lessonEdit: () => setLessonEdit(null),
      backup: () => setBackupOpen(false),
      history: () => setHistoryOpen(false),
      fav: () => setFavOpen(false),
      settings: () => setSettingsOpen(false),
    };
    const onKeyDown = (e) => {
      const node = modalRefs.current[open];
      if (e.key === 'Escape') { e.preventDefault(); closers[open](); return; }
      if (e.key !== 'Tab' || !node) return;
      const focusables = Array.from(node.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'))
        .filter((el) => !el.disabled && el.offsetParent !== null);
      if (!focusables.length) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (!node.contains(document.activeElement)) { e.preventDefault(); first.focus(); return; }
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', onKeyDown);
    const timer = setTimeout(() => modalRefs.current[open]?.querySelector('button, input, select, textarea')?.focus(), 40);
    return () => { document.removeEventListener('keydown', onKeyDown); clearTimeout(timer); };
  }, [camOpen, materialOpen, newJobOpen, libModalOpen, lessonEdit, backupOpen, historyOpen, favOpen, settingsOpen, getCloseCamera, getMaterialBusy]);

  /** 有没有任何弹窗开着（用于全局快捷键 / 滚动锁定这类判断） */
  const anyOpen = Boolean(camOpen || materialOpen || newJobOpen || libModalOpen || lessonEdit || backupOpen || historyOpen || favOpen || settingsOpen);

  return {
    settingsOpen, setSettingsOpen,
    materialOpen, setMaterialOpen,
    historyOpen, setHistoryOpen,
    favOpen, setFavOpen,
    libModalOpen, setLibModalOpen,
    newJobOpen, setNewJobOpen,
    backupOpen, setBackupOpen,
    camOpen, setCamOpen,
    lessonEdit, setLessonEdit,
    backupTip, setBackupTip,
    libTip, setLibTip,
    modalRefs, anyOpen,
  };
}
