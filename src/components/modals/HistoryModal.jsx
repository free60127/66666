import React, { useState } from 'react';
import { Trash2, X } from 'lucide-react';
import { formatTime, formatDuration } from '../../format.js';

/**
 * 历史作业弹窗：最近 20 条本机记录，点一条即可恢复那次批改结果。
 * （结果本身存在服务端，所以换设备打开分享链接也能看；这里只是本机的"最近列表"。）
 *
 * 删除：本机记录与服务端记录一起删，分享链接随即失效。
 * 二次确认是刻意的 —— 删掉之后分享出去的那条链接就打不开了，误触代价不小。
 */
function HistoryModal({ open, onClose, modalRef, items, onOpen, onDelete }) {
  const [confirmId, setConfirmId] = useState('');
  const [busyId, setBusyId] = useState('');
  const [errTip, setErrTip] = useState('');

  if (!open) return null;

  const doDelete = async (jobId) => {
    if (!onDelete) return;
    setBusyId(jobId);
    setErrTip('');
    const r = await onDelete(jobId);
    setBusyId('');
    setConfirmId('');
    if (!r || !r.ok) setErrTip((r && r.error) || '删除失败，请稍后重试');
  };

  return (
          <div className="modal-mask" onClick={onClose}>
            <div className="modal history-modal" ref={modalRef} role="dialog" aria-modal="true" aria-label="历史作业" onClick={(e) => e.stopPropagation()}>
              <div className="modal-head"><h2>历史作业</h2><button className="icon-btn" onClick={onClose} aria-label="关闭"><X size={16} /></button></div>
              {items.length === 0 ? <p className="muted">暂无历史记录。生成一次完整分析后，记录会自动保存在这里；此功能上线前生成的旧作业不会自动补录。</p> : (
                <div className="history-list">
                  {items.map((h) => (
                    <div className="history-item" key={h.jobId}>
                      <button className="history-open" onClick={() => onOpen(h.jobId)}>
                        <span className="history-info"><strong>{h.title || '回译作业'}</strong><span className="muted small">{formatTime(h.time)}{h.durationMs ? ` · 用时 ${formatDuration(h.durationMs)}` : ''}</span></span>
                        <span className="history-link">查看结果</span>
                      </button>
                      {confirmId === h.jobId ? (
                        <span className="history-del-confirm">
                          <button className="link danger" onClick={() => doDelete(h.jobId)} disabled={busyId === h.jobId}>
                            {busyId === h.jobId ? '删除中…' : '确认删除'}
                          </button>
                          <button className="link" onClick={() => setConfirmId('')} disabled={busyId === h.jobId}>取消</button>
                        </span>
                      ) : (
                        <button
                          className="icon-btn history-del"
                          onClick={() => { setConfirmId(h.jobId); setErrTip(''); }}
                          aria-label={`删除「${h.title || '回译作业'}」`}
                          title="删除这条记录（服务端一并删除，已分享的链接将失效）"
                        >
                          <Trash2 size={15} />
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              )}
              {errTip ? <p className="history-del-err" role="alert">{errTip}</p> : null}
              <p className="muted small">历史记录保存在当前浏览器（最近 20 条）；每次结果也会留存在服务端，把分享链接发到任何设备都能打开。删除会把服务端那份一起删掉。</p>
            </div>
          </div>
  );
}

export default React.memo(HistoryModal);
