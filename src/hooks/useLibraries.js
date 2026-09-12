/**
 * 自建课文库：库与课文的增删改（含改标题 / 改序号 / 重排序号）。
 *
 * 为什么单独成 hook：课文库是一个完整的小域（库列表、当前选中库、新建/删除、
 * 课文的改名与排序），却把状态和动作散在 App 的十来处；纯逻辑已经在 lessonLibrary.js 里，
 * 这里收拢的是状态与编排。
 *
 * 边界：**选课会写编辑区**（标题/中文/原文），那属于 useLessons/编辑域的职责，
 * 所以本 hook 只通过 `onLessonEdited` 回调把结果告诉调用方，不直接碰编辑区状态。
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  createLibrary, ensureLessonIds, findLesson, loadLibraries, moveLesson,
  removeLesson, removeLibrary, renameLesson, renumberLibrary, saveLibraries, upsertLesson,
} from '../lessonLibrary.js';

/**
 * @param {object} o
 * @param {Function} o.flash 提示
 * @param {Function} o.onLessonEdited 课文被改名/挪位后的回调（(after, before, titleCn) => void）
 * @param {Function} o.getSelectedLesson 取"当前正在练的那节课"（用来同步刷新）
 * @param {Function} o.onSelectedLessonChanged 当前课的标题/序号变了时通知 App
 */
export function useLibraries({ toast, setLibTip, onLessonEdited, getSelectedLesson, onSelectedLessonChanged }) {
  const [myLibs, setMyLibs] = useState(loadLibraries);
  const [myLibId, setMyLibId] = useState(''); // 当前选中的自建库（空 = 用内置册）
  const [libPickId, setLibPickId] = useState('');
  const [newLibName, setNewLibName] = useState('');

  const activeLib = useMemo(() => myLibs.find((l) => l.id === myLibId) || null, [myLibs, myLibId]);

  // 老数据迁移：给还没有稳定 id（lid）的自建课文补上并落盘。
  // 必须落盘，而不是"每次读的时候临时生成" —— 临时 id 每次都会变，练习记录就对不上了。
  useEffect(() => {
    const { list, changed } = ensureLessonIds(myLibs);
    if (!changed) return;
    setMyLibs(list);
    saveLibraries(list);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** 写入本机存储；失败时明确提示（配额满是很常见的失败原因） */
  const persist = useCallback((next) => {
    setMyLibs(next);
    if (saveLibraries(next)) return true;
    toast('写入本机存储失败（空间可能已满），请先清理浏览器数据或导出备份', 5000);
    return false;
  }, [toast]);

  const openLibModal = useCallback(() => {
    setLibPickId(myLibs[0]?.id || '');
    setNewLibName('');
    if (setLibTip) setLibTip('');
  }, [myLibs, setLibTip]);

  /** 选中一个库（只切侧栏列表，不改变当前作业） */
  const selectMyLib = useCallback((libId) => setMyLibId(libId), []);

  const deleteLibrary = useCallback((libId, libName) => {
    if (!window.confirm(`删除课文库「${libName}」？库里的课文会一起删掉，此操作不可撤销。`)) return;
    const next = removeLibrary(myLibs, libId);
    setMyLibs(next);
    saveLibraries(next);
    if (myLibId === libId) setMyLibId('');
    toast('已删除课文库「' + libName + '」', 3000);
  }, [myLibs, myLibId, toast]);

  const deleteMyLesson = useCallback((libId, lessonOrNo, label) => {
    if (!window.confirm(`从课文库删除「${label}」？\n\n（其它课的序号不会自动变；想补齐空档点「我的课文库」旁的「重排序号」）`)) return;
    // 传进来的可能是"整个课文对象"，也可能是序号或 lid：
    // 没有稳定 id 的老数据要退回用序号，否则 Number(对象) = NaN，删除会静默失效
    const target = (lessonOrNo && typeof lessonOrNo === 'object')
      ? (lessonOrNo.lid || lessonOrNo.lesson)
      : lessonOrNo;
    persist(removeLesson(myLibs, libId, target));
    toast('已删除课文「' + label + '」', 3000);
  }, [myLibs, persist, toast]);

  /**
   * 把当前作业存进课文库（**一次算完**）。
   *
   * 为什么必须是一个函数：先 createLib() 再 saveLesson() 的写法里，
   * 第二步拿到的是**这一次渲染的旧 myLibs**（新建的库还不在里面）→ 保存会静默失败。
   * 实测踩过：界面上点了保存、弹窗不关、库里什么都没有。
   * @returns {{ok: boolean, lesson?: object, error?: string}}
   */
  const saveToLibrary = useCallback(({ name, pickId, entry }) => {
    let list = myLibs;
    let targetId = pickId;
    const clean = String(name || '').trim();
    if (clean) {
      const dup = myLibs.find((l) => l.name === clean);
      if (dup) targetId = dup.id;
      else { list = createLibrary(myLibs, clean); targetId = list[list.length - 1].id; }
    }
    if (!targetId) return { ok: false, error: '请先选择或输入一个课文库名称' };
    const { list: next, replaced, lesson } = upsertLesson(list, targetId, entry);
    if (!persist(next)) return { ok: false, error: '写入本机存储失败（空间可能已满），请先清理浏览器数据' };
    setMyLibId(targetId);
    toast((replaced ? '已更新课文：' : '已保存课文：') + entry.title_cn
      + (entry.english ? '' : '（没填英文原文，练习时无法做原文对照）'), 4200);
    return { ok: true, lesson };
  }, [myLibs, persist, toast]);

  /** 打开「编辑课文」弹窗 */
  const openLessonEdit = useCallback((libId, lesson, setLessonEdit) => {
    if (!lesson) return;
    // 同时记住序号：万一这条数据还没有稳定 id（导入/同步进来的旧数据），
    // 也能按序号定位到它 —— 不能让"点编辑没反应"这种事再发生
    setLessonEdit({ libId, lid: lesson.lid || '', lesson: lesson.lesson });
  }, []);

  /** 按 { libId, lid, lesson } 找到要编辑的那节课（lid 优先，退回序号） */
  const resolveEditLesson = useCallback((target) => {
    if (!target) return null;
    const lib = myLibs.find((x) => x.id === target.libId);
    return findLesson(lib, target.lid) || findLesson(lib, target.lesson);
  }, [myLibs]);

  /** 保存编辑：先改标题，再按需挪序号；两件事落在同一份新列表上 */
  const saveLessonEdit = useCallback(({ title_cn, title_en, lesson: targetNo }, editTarget, closeEdit) => {
    const before = resolveEditLesson(editTarget);
    if (!before) { closeEdit(); return; }
    // 老数据（没有稳定 id）在这里补一个：这一次编辑之后它就固定下来了
    const withIds = ensureLessonIds(myLibs).list;
    const lid = before.lid || (findLesson(withIds.find((x) => x.id === editTarget.libId), before.lesson) || {}).lid;
    if (!lid) { closeEdit(); return; }
    let next = renameLesson(withIds, editTarget.libId, lid, { title_cn, title_en });
    const wantNo = Math.round(Number(targetNo) || before.lesson);
    if (wantNo !== before.lesson) next = moveLesson(next, editTarget.libId, lid, wantNo);
    const after = findLesson(next.find((x) => x.id === editTarget.libId), lid);
    const ok = persist(next);
    closeEdit();
    if (!ok) return;
    if (onLessonEdited) onLessonEdited(after, before, title_cn);
    const moved = after && after.lesson !== before.lesson;
    toast('已保存：' + ((after && after.title_cn) || title_cn)
      + (moved ? `（挪到第 ${after.lesson} 课，其余顺移）` : ''), 3600);
  }, [myLibs, resolveEditLesson, persist, toast, onLessonEdited]);

  /** 一键把序号补齐成 1、2、3…（补上删课留下的空档） */
  const renumberMyLib = useCallback((libId) => {
    const lib = myLibs.find((x) => x.id === libId);
    if (!lib || !lib.lessons.length) return;
    const next = renumberLibrary(myLibs, libId);
    persist(next);
    const after = next.find((x) => x.id === libId);
    const selected = getSelectedLesson && getSelectedLesson();
    if (myLibId === libId && selected && selected.lid && onSelectedLessonChanged) {
      const fresh = findLesson(after, selected.lid);
      if (fresh) onSelectedLessonChanged(fresh);
    }
    toast(`已重排序号：${after.lessons.length} 节课现在是 1…${after.lessons.length}`, 3200);
  }, [myLibs, myLibId, persist, toast, getSelectedLesson, onSelectedLessonChanged]);

  return {
    myLibs, setMyLibs, myLibId, setMyLibId, libPickId, setLibPickId, newLibName, setNewLibName,
    activeLib, persist, openLibModal, selectMyLib, deleteLibrary, deleteMyLesson,
    saveToLibrary, openLessonEdit, resolveEditLesson, saveLessonEdit, renumberMyLib,
  };
}
