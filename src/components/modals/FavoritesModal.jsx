import React from 'react';
import { ClipboardCopy, Download, Flame, LoaderCircle, Trash2, Upload, WandSparkles, X } from 'lucide-react';
import { FAV_KIND_LABEL, dueLabel, dueOf } from '../../favorites.js';
import { formatTime } from '../../format.js';
import { LEVEL_LABEL } from '../../constants.js';
import { FavReviewPanel } from '../ResultSheet/Review.jsx';

/**
 * 收藏夹弹窗（含 SM-2 复习会话与"根据收藏自测"入口）。
 * 纯展示：收藏数据、复习会话、筛选条件都由 App 持有，这里只负责渲染 + 回调。
 * 抽出来的原因：它是 App.jsx 里最长的一段 JSX（约 85 行），而且和编辑逻辑毫无关系。
 */
export default function FavoritesModal({
  open, onClose, modalRef,
  favorites, visibleFavorites, favQuery, onQuery, favKind, onKind, dueCount,
  review, onStartReview, onReveal, onGrade, onSkip, onExitReview,
  onRemove, onExport, onImportClick, favFileRef, onImportFile, onCopy, onClear,
  quizCount, onQuizCount, onGenerateQuiz, quizBusy, polishLevel,
}) {
  if (!open) return null;
  return (
          <div className="modal-mask" onClick={onClose}>
            <div className="modal fav-modal" ref={modalRef} role="dialog" aria-modal="true" aria-label="收藏夹" onClick={(e) => e.stopPropagation()}>
              <div className="modal-head">
                <h2>{review ? '今日复习' : `收藏夹（${favorites.length}）`}</h2>
                <button className="icon-btn" onClick={onClose} aria-label="关闭"><X size={16} /></button>
              </div>
              {review ? (
                <FavReviewPanel
                  session={review}
                  items={favorites}
                  onReveal={onReveal}
                  onGrade={onGrade}
                  onSkip={onSkip}
                  onExit={onExitReview}
                />
              ) : (
                <>
                  <div className="fav-toolbar">
                    <input className="fav-search" value={favQuery} onChange={(e) => onQuery(e.target.value)} placeholder="搜索单词、短语或解释…" />
                    <select className="ocr-mode" value={favKind} onChange={(e) => onKind(e.target.value)}>
                      <option value="all">全部</option>
                      <option value="finding">错题 / 辨析</option>
                      <option value="vocab">核心词</option>
                      <option value="idiom">习语</option>
                      <option value="expression">加分表达</option>
                    </select>
                    <button className="ghost-btn" onClick={onStartReview} disabled={!favorites.length} title="按间隔重复安排复习：今天到期的收藏">
                      <Flame size={14} />今日待复习{dueCount ? ` (${favDueCount})` : ''}
                    </button>
                  </div>
                  {favorites.length === 0 ? (
                    <p className="muted">还没有收藏。在作业结果里点每条知识点右上角的 ☆ 就能收藏，之后在这里直接复习，不用再打开整份作业。</p>
                  ) : visibleFavorites.length === 0 ? (
                    <p className="muted">没有匹配的收藏。</p>
                  ) : (
                    <div className="fav-list">
                      {visibleFavorites.map((x) => {
                        const due = dueOf(x) <= Date.now();
                        return (
                          <div className={'fav-item' + (due ? ' due' : '')} key={x.id}>
                            <div className="fav-item-head">
                              <span className="fav-kind">{FAV_KIND_LABEL[x.kind] || x.kind}</span>
                              {x.category ? <span className="fav-cat">{x.category}</span> : null}
                              {x.level ? <span className={'fav-level ' + x.level}>{LEVEL_LABEL[x.level] || x.level}</span> : null}
                              <span className={'fav-due' + (due ? ' now' : '')}>{due ? '待复习' : dueLabel(x)}</span>
                              <span className="fav-date">{formatTime(x.createdAt)}</span>
                              <button className="icon-btn fav-del" onClick={() => onRemove(x.id)} title="删除这条收藏"><Trash2 size={14} /></button>
                            </div>
                            <div className="fav-title">{x.title}</div>
                            {x.body ? <div className="fav-body">{x.body}</div> : null}
                            {x.extra ? <div className="fav-extra">{x.extra}</div> : null}
                            {x.source ? <div className="fav-source">来自：{x.source}{x.sourceLevel ? ' · 润色等级 ' + x.sourceLevel : ''}</div> : null}
                          </div>
                        );
                      })}
                    </div>
                  )}
                  <div className="fav-quiz">
                    <div className="fav-quiz-title">根据收藏自测</div>
                    <div className="fav-quiz-row">
                      <label className="fav-quiz-count">题目数量
                        <select className="ocr-mode" value={quizCount} onChange={(e) => onQuizCount(Number(e.target.value))}>
                          {[5, 10, 15, 20, 30, 50].map((n) => <option key={n} value={n}>{n} 题</option>)}
                        </select>
                      </label>
                      <button className="primary-btn" onClick={onGenerateQuiz} disabled={quizBusy || !favorites.length}>
                        {quizBusy ? <LoaderCircle className="spin" size={15} /> : <WandSparkles size={15} />}
                        {quizBusy ? 'AI 正在出题…' : '生成自测题'}
                      </button>
                    </div>
                    <p className="muted small">按当前筛选范围出题（{favKind === 'all' ? '全部收藏' : (FAV_KIND_LABEL[favKind] || favKind)}），难度跟随「润色等级 {polishLevel}」；生成后点「导出 PDF」即可打印，答案统一印在最后。</p>
                  </div>
                  <div className="fav-footer">
                    <button className="ghost-btn sm" onClick={onExport}><Download size={14} />导出备份</button>
                    <button className="ghost-btn sm" onClick={onImportClick}><Upload size={14} />导入备份</button>
                    <button className="ghost-btn sm" onClick={onCopy} disabled={!favorites.length}><ClipboardCopy size={14} />复制全部</button>
                    <button className="ghost-btn sm" onClick={onClear} disabled={!favorites.length}><Trash2 size={14} />清空</button>
                    <input ref={favFileRef} type="file" accept="application/json,.json" hidden onChange={(e) => { const f = e.target.files && e.target.files[0]; e.target.value = ''; onImportFile(f); }} />
                  </div>
                  <p className="muted small">收藏与<b>复习进度</b>保存在本机浏览器（不依赖数据库）；配了同步码时会跟着一起同步，多设备之间以复习得更新的那份为准。清除浏览器数据、换浏览器 / 设备、或更换域名都会导致收藏丢失，建议定期「导出备份」。</p>
                </>
              )}
            </div>
          </div>
  );
}
