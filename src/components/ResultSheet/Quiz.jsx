/**
 * 收藏知识点自测卷。两种用法共用一份题目：
 *  · **屏幕上做**（默认）：选择题点选项立刻判对错，填空/改错写完点「核对」，
 *    翻译/造句点底部「批改」交给 AI（AI 不可用时对照标准答案自评）；
 *  · **打印 / 导出 PDF**：右上角仍可显示/隐藏答案，打印时答案与解析统一印在最后。
 *
 * 判分规则在 src/quizGrade.js，作答与批改状态在 hooks/useQuizGrade.js —— 这里只负责画。
 */import React from 'react';
import { ArrowLeft, CheckCheck, ClipboardCopy, Download, LoaderCircle, RotateCcw, Star } from 'lucide-react';
import { VERDICT_LABEL, answerLetter, gradingMode, optionLabel, optionText } from '../../quizGrade.js';
import { useQuizGrade } from '../../hooks/useQuizGrade.js';

const BY_LABEL = { local: '本地判定', ai: 'AI 批改', self: '自评' };

/** 判定结果那一条：标签 + 点评 + 标准答案 + 解析（自评态多两个按钮） */
function VerdictBox({ q, v, onSelf }) {
  const pending = v.status === 'pending';
  return (
    <div className={'quiz-verdict ' + (pending ? 'pending' : v.status)}>
      <div className="quiz-verdict-head">
        <span className="quiz-verdict-tag">{pending ? '待自评' : (VERDICT_LABEL[v.status] || '')}</span>
        <span className="quiz-verdict-by">
          {pending
            ? (v.local ? '本地判：' + (VERDICT_LABEL[v.local] || '') + ' · AI 暂时用不了，自己判' : 'AI 暂时用不了，自己判')
            : (BY_LABEL[v.by] || '')}
        </span>
      </div>
      {v.comment ? <div className="quiz-verdict-comment">{v.comment}</div> : null}
      {v.better ? <div className="quiz-verdict-better"><strong>更好的表达：</strong>{v.better}</div> : null}
      {q.answer ? <div className="quiz-verdict-answer"><strong>标准答案：</strong>{q.answer}</div> : null}
      {q.explanation ? <div className="quiz-exp"><strong>解析：</strong>{q.explanation}</div> : null}
      {pending ? (
        <div className="quiz-self-judge">
          <span>对照之后，你自己判：</span>
          <button className="ghost-btn sm" onClick={() => onSelf(true)}>我写对了</button>
          <button className="ghost-btn sm" onClick={() => onSelf(false)}>我写错了</button>
        </div>
      ) : null}
    </div>
  );
}

function QuizSheetImpl({ quiz, settings, showAnswers, onToggleAnswers, onBack, onBackToFav, onCopy, tip }) {
  const qs = quiz && Array.isArray(quiz.questions) ? quiz.questions : [];
  const g = useQuizGrade({ quiz, settings });
  const s = g.summary;
  const touched = Object.keys(g.answers).length > 0;

  return (
    <div className="result-sheet quiz-sheet">
      <div className="result-toolbar">
        <button className="ghost-btn" onClick={onBack}><ArrowLeft size={15} />返回编辑</button>
        <button className="ghost-btn" onClick={onBackToFav}><Star size={15} />收藏夹</button>
        <button className="ghost-btn" onClick={onToggleAnswers}>{showAnswers ? '隐藏答案' : '显示答案'}</button>
        <button className="ghost-btn" onClick={onCopy}><ClipboardCopy size={15} />复制题目</button>
        <button className="ghost-btn" onClick={() => window.print()}><Download size={15} />导出 PDF</button>
        {tip ? <span className="share-tip">{tip}</span> : null}
      </div>
      <article className="sheet">
        <header className="sheet-title">
          <span className="eyebrow">SELF-CHECK QUIZ · 收藏知识点自测</span>
          <h1>{quiz.title}</h1>
          <span className="sheet-duration">共 {qs.length} 题{quiz.local ? ' · 本地兜底生成' : ''}{quiz.level ? ' · 润色等级 ' + quiz.level : ''}</span>
        </header>
        <p className="quiz-hint">直接在屏幕上做：选择题点选项立刻判对错，填空 / 改错写完点「核对」，翻译 / 造句点底部「批改」交给 AI。导出 PDF 时答案与解析会统一印在最后。</p>
        <ol className="quiz-list">
          {qs.map((q, i) => {
            const mode = gradingMode(q);
            const v = g.verdicts[i];
            const ans = g.answers[i] || '';
            return (
              <li className={'quiz-item' + (v ? ' judged-' + v.status : '')} key={'q' + (q.question || '') + '#' + i}>
                <div className="quiz-head">
                  <span className="quiz-no">{i + 1}</span>
                  <span className="quiz-type">{q.type || '问答'}</span>
                  {v && v.status !== 'pending' ? <span className={'quiz-mark ' + v.status}>{VERDICT_LABEL[v.status]}</span> : null}
                  {v && mode === 'choice' ? <button className="quiz-retry" onClick={() => g.clearOne(i)}>重做本题</button> : null}
                </div>
                <div className="quiz-question">{q.question}</div>

                {mode === 'choice' ? (
                  <ul className="quiz-options interactive">
                    {q.options.map((o, j) => {
                      const letter = optionLabel(o, j);
                      const picked = ans === letter;
                      const isAnswer = v && answerLetter(q) === letter;
                      const cls = ['quiz-opt'];
                      if (picked) cls.push('picked');
                      if (v && picked) cls.push(v.status === 'close' ? 'close' : v.status);
                      if (isAnswer && !(picked && v && v.status === 'right')) cls.push('is-answer');
                      return (
                        <li key={'o' + j}>
                          <button type="button" className={cls.join(' ')} disabled={Boolean(v)} onClick={() => g.chooseOption(i, letter)}>
                            <span className="quiz-opt-key">{letter}</span>
                            <span className="quiz-opt-text">{optionText(o) || o}</span>
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                ) : (
                  <div className="quiz-input-row">
                    {mode === 'fix' ? (
                      <textarea className="quiz-input" rows={2} value={ans} placeholder="写出改好的整句…" onChange={(e) => g.setAnswer(i, e.target.value)} />
                    ) : mode === 'blank' ? (
                      <input
                        className="quiz-input"
                        value={ans}
                        placeholder="填入空格处的内容…"
                        onChange={(e) => g.setAnswer(i, e.target.value)}
                        onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); g.judgeOne(i); } }}
                      />
                    ) : (
                      <textarea className="quiz-input" rows={3} value={ans} placeholder="用英文写下你的答案…" onChange={(e) => g.setAnswer(i, e.target.value)} />
                    )}
                    {mode === 'subjective' ? (
                      <span className="quiz-input-hint">写完点底部「批改」</span>
                    ) : (
                      <button className="ghost-btn" onClick={() => g.judgeOne(i)} disabled={!String(ans).trim()}>核对</button>
                    )}
                  </div>
                )}

                {v ? <VerdictBox q={q} v={v} onSelf={(ok) => g.selfJudge(i, ok)} /> : null}
              </li>
            );
          })}
        </ol>
        {!qs.length ? <p className="muted">还没有题目，请先在收藏夹里收藏一些知识点再生成。</p> : null}

        {/* 答案区：屏幕默认隐藏，导出 PDF 时始终印在最后 */}
        <section className={'quiz-answers' + (showAnswers ? '' : ' hidden')}>
          <h2 className="quiz-answers-title">答案与解析</h2>
          {qs.map((q, i) => (
            <div className="quiz-answer-item" key={'a' + i}>
              <div className="quiz-answer-line">
                <span className="quiz-no">{i + 1}</span>
                <strong>答案：</strong>{q.answer}
              </div>
              {q.explanation ? <div className="quiz-exp"><strong>解析：</strong>{q.explanation}</div> : null}
              {q.source ? <div className="quiz-src">考点：{q.source}</div> : null}
            </div>
          ))}
        </section>
      </article>

      {qs.length ? (
        <div className="quiz-grade-dock">
          {g.tip ? <div className="quiz-grade-tip">{g.tip}</div> : null}
          <div className="quiz-grade-bar">
            <div className="quiz-grade-stat">
              {s.judged || s.selfPending ? (
                <>
                  已批改 <strong>{s.judged}</strong> / {s.total} 题
                  <span className="quiz-score ok">对 {s.right}</span>
                  <span className="quiz-score mid">接近 {s.close}</span>
                  <span className="quiz-score bad">错 {s.wrong}</span>
                  {s.selfPending ? <span className="quiz-score pending">待自评 {s.selfPending}</span> : null}
                </>
              ) : ('共 ' + s.total + ' 题 —— 做完点右边「批改」')}
            </div>
            {g.aiBusy ? (
              <span className="quiz-grade-running"><LoaderCircle className="spin" size={14} />AI 正在批改主观题{g.aiElapsed ? ' · ' + g.aiElapsed + 's' : ''}</span>
            ) : null}
            <button className="ghost-btn" onClick={g.resetAll} disabled={g.aiBusy || (!s.judged && !s.selfPending && !touched)}><RotateCcw size={14} />重做</button>
            <button className="primary-btn" onClick={g.gradeAll} disabled={g.aiBusy}><CheckCheck size={15} />{g.aiBusy ? '批改中…' : '批改'}</button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
export const QuizSheet = React.memo(QuizSheetImpl);
