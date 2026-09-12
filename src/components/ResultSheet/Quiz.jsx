/**
 * 收藏知识点自测卷（题目 / 答案分离，可导出 PDF）。
 */import React from 'react';
import { ArrowLeft, ClipboardCopy, Download, Star } from 'lucide-react';
import { quiz } from '../../api.js';

export function QuizSheet({ quiz, showAnswers, onToggleAnswers, onBack, onBackToFav, onCopy, tip }) {
  const qs = quiz && Array.isArray(quiz.questions) ? quiz.questions : [];
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
        <p className="quiz-hint">先自己做完，再点右上角「显示答案」对照；导出 PDF 时答案与解析会统一印在最后。</p>
        <ol className="quiz-list">
          {qs.map((q, i) => (
            <li className="quiz-item" key={'q' + (q.question || '') + '#' + i}>
              <div className="quiz-head">
                <span className="quiz-no">{i + 1}</span>
                <span className="quiz-type">{q.type || '问答'}</span>
              </div>
              <div className="quiz-question">{q.question}</div>
              {Array.isArray(q.options) && q.options.length ? (
                <ul className="quiz-options">{q.options.map((o, j) => <li key={'o' + j}>{o}</li>)}</ul>
              ) : null}
            </li>
          ))}
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
    </div>
  );
}
