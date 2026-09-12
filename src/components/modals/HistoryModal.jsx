import React from 'react';
import { X } from 'lucide-react';
import { formatTime, formatDuration } from '../../format.js';

/**
 * 历史作业弹窗：最近 20 条本机记录，点一条即可恢复那次批改结果。
 * （结果本身存在服务端，所以换设备打开分享链接也能看；这里只是本机的"最近列表"。）
 */
export default function HistoryModal({ open, onClose, modalRef, items, onOpen }) {
  if (!open) return null;
  return (
          <div className="modal-mask" onClick={onClose}>
            <div className="modal history-modal" ref={modalRef} role="dialog" aria-modal="true" aria-label="历史作业" onClick={(e) => e.stopPropagation()}>
              <div className="modal-head"><h2>历史作业</h2><button className="icon-btn" onClick={onClose} aria-label="关闭"><X size={16} /></button></div>
              {items.length === 0 ? <p className="muted">暂无历史记录。生成一次完整分析后，记录会自动保存在这里；此功能上线前生成的旧作业不会自动补录。</p> : (
                <div className="history-list">
                  {items.map((h) => (
                    <button className="history-item" key={h.jobId} onClick={() => onOpen(h.jobId)}>
                      <span className="history-info"><strong>{h.title || '回译作业'}</strong><span className="muted small">{formatTime(h.time)}{h.durationMs ? ` · 用时 ${formatDuration(h.durationMs)}` : ''}</span></span>
                      <span className="history-link">查看结果</span>
                    </button>
                  ))}
                </div>
              )}
              <p className="muted small">历史记录保存在当前浏览器（最近 20 条）；每次结果也会留存在服务端，把分享链接发到任何设备都能打开。</p>
            </div>
          </div>
  );
}
