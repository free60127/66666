import React, { useMemo, useRef, useState } from 'react';
import { AlertTriangle, FileUp, Sparkles, Target, X } from 'lucide-react';

/**
 * 错误训练：挑几课 → 用这几课里**实际犯过的错**出题。
 *
 * 两个刻意的设计：
 *  1) **默认帮你勾好** —— 按"错得最多的前几课"预选。一进来就是可用的状态，
 *     想改再改；让用户从 96 课里自己挑是本末倒置。
 *  2) **没记录的课不装作能出题** —— 历史只有最近 20 条，更早练过的课可能已经查不到结果。
 *     这种课单独列在下半部分，明说"找不到作业记录"，并给一条出路：上传该课 PDF/图片。
 *     给个能点但点了没用的按钮，比不给更糟。
 */
export default function ErrorDrillModal({
  rows, selected, onToggle, onSelectTop, onSelectAll, onClear,
  materials, onUploadMaterial, onRemoveMaterial, busy, tip, count, onCount,
  onStart, onClose, hasKey,
}) {
  const fileRef = useRef(null);
  const [uploadFor, setUploadFor] = useState(null);
  const [localErr, setLocalErr] = useState('');

  const chosen = useMemo(() => rows.filter((r) => selected.has(r.key)), [rows, selected]);
  const stats = useMemo(() => {
    const byCat = new Map();
    let errors = 0;
    let improves = 0;
    for (const r of chosen) {
      errors += r.errors.length;
      improves += r.improves.length;
      for (const [cat, n] of Object.entries(r.byCategory || {})) byCat.set(cat, (byCat.get(cat) || 0) + n);
    }
    return { errors, improves, cats: [...byCat].sort((a, b) => b[1] - a[1]).slice(0, 6) };
  }, [chosen]);

  const withErrors = rows.filter((r) => r.errors.length || r.improves.length);
  const without = rows.filter((r) => !r.errors.length && !r.improves.length);
  const materialKeys = new Set(materials.map((m) => m.key));

  const pickFile = (row) => {
    setLocalErr('');
    setUploadFor(row);
    if (fileRef.current) {
      fileRef.current.value = '';
      fileRef.current.click();
    }
  };

  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="modal drill-modal" role="dialog" aria-modal="true" aria-label="错误训练" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2><Target size={16} />错误训练</h2>
          <button className="icon-btn" onClick={onClose} aria-label="关闭"><X size={16} /></button>
        </div>
        <p className="muted small">
          挑几课，用你在这几课里<b>实际写错的地方</b>出针对性练习（改错/填空/翻译为主，
          每题都会点明你上次错在哪）。默认已经帮你勾了错得最多的几课。
        </p>

        {withErrors.length === 0 ? (
          <div className="drill-empty">
            <AlertTriangle size={16} />
            <div>
              <strong>这个课文库里还没有可训练的错题。</strong>
              <p className="muted small">
                错误训练要靠「你写过的作业」里的批改记录。先去练一两课（生成一次作业），
                批改结果会存进历史，之后这里就能用了。
                <br />
                如果那些课是很久以前练的（历史只保留最近 20 条），可以点下面的「上传该课 PDF」——
                它会作为出题素材。
              </p>
            </div>
          </div>
        ) : (
          <>
            <div className="drill-toolbar">
              <button className="ghost-btn sm" onClick={onSelectTop}>错得最多的 5 课</button>
              <button className="ghost-btn sm" onClick={onSelectAll}>全选</button>
              <button className="ghost-btn sm" onClick={onClear}>清空</button>
              <span className="muted small" style={{ marginLeft: 'auto' }}>
                已选 <b>{chosen.length}</b> 课 · <b>{stats.errors}</b> 处错误
                {stats.improves ? ` · ${stats.improves} 处可提升` : ''}
              </span>
            </div>

            <ul className="drill-list">
              {withErrors.map((r) => {
                const on = selected.has(r.key);
                const cats = Object.entries(r.byCategory || {}).sort((a, b) => b[1] - a[1]).slice(0, 3);
                return (
                  <li key={r.key} className={'drill-row' + (on ? ' on' : '')}>
                    <label className="drill-pick">
                      <input type="checkbox" checked={on} onChange={() => onToggle(r.key)} />
                      <span className="drill-name">{r.name}</span>
                    </label>
                    <span className="drill-count">
                      {r.errors.length ? `${r.errors.length} 处错误` : '无错误'}
                      {r.improves.length ? ` · ${r.improves.length} 可提升` : ''}
                    </span>
                    <span className="drill-cats">
                      {cats.map(([c, n]) => <i key={c} className="drill-cat">{c} {n}</i>)}
                    </span>
                    {r.attempts ? <span className="muted small drill-times">练过 {r.attempts} 次</span> : null}
                  </li>
                );
              })}
            </ul>

            {stats.cats.length ? (
              <p className="muted small" style={{ marginTop: 6 }}>
                选中的错误类型：{stats.cats.map(([c, n]) => `${c}×${n}`).join('、')}
              </p>
            ) : null}
          </>
        )}

        {/* 没记录的课：说实话 + 给一条出路 */}
        {without.length ? (
          <details className="drill-missing" open={withErrors.length === 0}>
            <summary>{without.length} 课找不到作业记录（可上传该课 PDF 作为素材）</summary>
            <ul className="drill-list">
              {without.map((r) => (
                <li key={r.key} className="drill-row">
                  <span className="drill-name">{r.name}</span>
                  {materialKeys.has(r.key)
                    ? <span className="drill-count ok">已上传材料</span>
                    : <span className="muted small">没有批改记录</span>}
                  <span style={{ marginLeft: 'auto' }}>
                    {materialKeys.has(r.key)
                      ? <button className="ghost-btn sm" onClick={() => onRemoveMaterial(r.key)}>移除</button>
                      : <button className="ghost-btn sm" onClick={() => pickFile(r)} disabled={busy}><FileUp size={13} />上传该课 PDF</button>}
                  </span>
                </li>
              ))}
            </ul>
          </details>
        ) : null}

        {materials.length ? (
          <p className="muted small">
            已上传 {materials.length} 份材料（{materials.map((m) => m.name).join('、')}），
            出题时会作为选词/语境的素材 —— 它们<b>不是</b>你的错题，所以不会被当成错误来考。
          </p>
        ) : null}

        <input ref={fileRef} type="file" accept="application/pdf,image/*" style={{ display: 'none' }}
          onChange={(e) => {
            const f = e.target.files && e.target.files[0];
            if (!f || !uploadFor) return;
            if (f.size > 12 * 1024 * 1024) { setLocalErr('文件太大了（上限 12MB）'); return; }
            onUploadMaterial(uploadFor, f);
            setUploadFor(null);
          }} />

        {localErr ? <p className="fav-tip error-tip">{localErr}</p> : null}
        {tip ? <p className="muted small">{tip}</p> : null}
        {!hasKey ? <p className="fav-tip error-tip">还没配置 AI Key：可在「AI 设置」里填写，或用服务端已配置的模型。</p> : null}

        <div className="modal-actions">
          <label className="drill-count-pick">
            题量
            <select className="ocr-mode" value={count} onChange={(e) => onCount(Number(e.target.value))}>
              {[5, 10, 15, 20].map((n) => <option key={n} value={n}>{n} 题</option>)}
            </select>
          </label>
          <button className="ghost-btn" onClick={onClose}>取消</button>
          <button className="primary-btn" disabled={busy || !chosen.length || !stats.errors && !materials.length}
            onClick={onStart}>
            <Sparkles size={15} />{busy ? '出题中…' : '开始出题'}
          </button>
        </div>
      </div>
    </div>
  );
}
