import { useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Expand, RotateCcw, X, ZoomIn, ZoomOut } from 'lucide-react'

function ImageDialog({ src, title, onClose }) {
  const dialogRef = useRef(null);
  const stageRef = useRef(null);
  const headingId = useId();
  const [zoom, setZoom] = useState(1);
  const [natural, setNatural] = useState(null);
  const [fitWidth, setFitWidth] = useState(0);

  useEffect(() => {
    const dialog = dialogRef.current;
    const opener = document.activeElement;
    const previousOverflow = document.body.style.overflow;
    dialog.showModal();
    document.body.style.overflow = 'hidden';
    return () => {
      dialog.close();
      document.body.style.overflow = previousOverflow;
      if (opener?.isConnected) opener.focus({ preventScroll: true });
    };
  }, []);

  useEffect(() => {
    if (!natural) return;
    const stage = stageRef.current;
    const fit = () => setFitWidth(Math.max(1, Math.min(natural.width, stage.clientWidth - 32, (stage.clientHeight - 32) * natural.width / natural.height)));
    fit();
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(fit) : null;
    observer?.observe(stage);
    window.addEventListener('resize', fit);
    return () => { observer?.disconnect(); window.removeEventListener('resize', fit); };
  }, [natural]);

  return createPortal(
    <dialog ref={dialogRef} className="ws-image-dialog" aria-modal="true" aria-labelledby={headingId}
      onCancel={(event) => { event.preventDefault(); event.stopPropagation(); onClose(); }}
      onClick={(event) => { event.stopPropagation(); if (event.target === event.currentTarget) onClose(); }}>
      <div className="ws-image-surface">
        <header className="ws-image-header">
          <h2 id={headingId}>{title} · 题目配图</h2>
          <button type="button" className="icon-btn" aria-label="关闭配图预览" onClick={onClose}><X size={21} /></button>
        </header>
        <div className="ws-image-tools">
          <span className="muted small">点击图片外侧或按 Esc 关闭</span>
          <button type="button" className="ghost-btn sm" aria-label="缩小配图" disabled={zoom <= 1} onClick={() => setZoom((value) => value - 0.5)}><ZoomOut size={16} /></button>
          <span className="ws-image-scale" aria-live="polite">{zoom}×</span>
          <button type="button" className="ghost-btn sm" aria-label="放大配图" disabled={zoom >= 3} onClick={() => setZoom((value) => value + 0.5)}><ZoomIn size={16} /></button>
          <button type="button" className="ghost-btn sm" disabled={zoom === 1} onClick={() => setZoom(1)}><RotateCcw size={14} />适合窗口</button>
        </div>
        <div ref={stageRef} className="ws-image-stage">
          <div className="ws-image-canvas" style={fitWidth ? { width: fitWidth * zoom } : undefined}>
            <img src={src} alt={title + '题目配图大图'} onLoad={(event) => setNatural({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight })} />
          </div>
        </div>
      </div>
    </dialog>, document.body,
  );
}

export default function TopicImage({ src, title, thumbnail = false }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className={'ws-image-trigger' + (thumbnail ? ' ws-image-thumbnail' : '')}
        aria-haspopup="dialog" aria-label={'查看大图：' + title}
        onClick={(event) => { event.stopPropagation(); setOpen(true); }}>
        <img className={thumbnail ? 'ws-card-img' : ''} src={src} alt={title + '题目配图'} loading={thumbnail ? 'lazy' : undefined} />
        <span className="ws-image-hint"><Expand size={13} />点击查看大图</span>
      </button>
      {open ? <ImageDialog src={src} title={title} onClose={() => setOpen(false)} /> : null}
    </>
  );
}
