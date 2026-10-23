import { useMemo, useState } from 'react';
import { listWritingDrafts, writingSourceKey } from '../writing.js';
import { listDrafts } from '../draftBox.js';
import { loadResultCache, safeGet, safeSet } from '../storage.js';
import { loadQuizSession } from '../quizSession.js';
import { learningRecommendations, nextWritingTopic } from '../learningHome.js';
import { WRITING_EXAM_BANK } from '../writingExamBank.js';
import { WRITING_TOPICS } from '../writingTopics.js';
import '../learningHome.css';

const topics = [...WRITING_EXAM_BANK, ...WRITING_TOPICS.map((topic) => ({ ...topic, id: 'own-' + topic.id, exam: 'own', label: '精选自编', qtype: topic.type }))];
export default function LearningHome({ history, favorites, progress, level, onAction, onWriting, onTranslation, onQuiz, nextLesson }) {
  const [focus, setFocus] = useState(() => safeGet('bt-study-focus', 'both'));
  const cards = useMemo(() => learningRecommendations({ history, favorites, progress, drafts: listWritingDrafts(),
    translationDrafts: listDrafts(), quizSession: loadQuizSession(), readResult: loadResultCache }), [history, favorites, progress]);
  const topic = nextWritingTopic(topics, progress, level);
  const quizzes = Object.entries(progress).filter(([key]) => key.startsWith('quiz:')).sort((a, b) => b[1].at - a[1].at);
  return <section className="learning-home">
    <div className="learning-home-head"><div><h1>今天，从这里继续</h1><p className="muted">先完成手边的练习，再巩固到期的知识点。</p></div>
      <label>学习重点<select aria-label="学习重点" value={focus} onChange={(e) => { setFocus(e.target.value); safeSet('bt-study-focus', e.target.value); }}>
        <option value="both">翻译与写作</option><option value="writing">英语写作</option><option value="translation">翻译训练</option>
      </select></label></div>
    <h2>下一步</h2>
    <div className="learning-home-cards">{cards.map((card, index) => <article key={card.kind + index}>
      <h3>{card.title}</h3><p className="muted">{card.reason}</p><button className="primary-btn" onClick={() => onAction(card)}>继续学习</button>
    </article>)}</div>
    {!cards.length ? <p className="muted">当前没有待继续的练习，选一个任务开始吧。</p> : null}
    <h2>开始新练习</h2><div className="learning-home-cards">
      {focus !== 'translation' && topic ? <article><h3>{topic.zh}</h3><p className="muted">{topic.label} · {progress[writingSourceKey(topic)]?.n ? '可再次练习巩固' : '尚未完成的写作题'}</p>
        <button className="ghost-btn" onClick={() => onWriting(topic)}>开始这篇写作</button></article> : null}
      {focus !== 'writing' ? <article><h3>{nextLesson ? '下一课：' + (nextLesson.title_cn || nextLesson.title_en || nextLesson.lesson) : '翻译训练'}</h3><p className="muted">{nextLesson ? '当前课文列表中尚未完成的一课。' : '回到课文练习，结合侧栏进度选择下一课。'}</p><button className="ghost-btn" onClick={onTranslation}>进入翻译练习</button></article> : null}
    </div>
    {quizzes.length ? <div className="learning-home-summary"><h2>最近自测</h2><p>最近一次正确率 <strong>{quizzes[0][1].last}%</strong> · 已记录 {quizzes.length} 份自测成绩</p>
      <p className="muted small">正确率包含本地核对、AI 批改或自评结果，仅供复习参考。登录后成绩摘要随学习进度同步，题目与作答保存在本机。</p>
      {loadQuizSession() ? <button className="ghost-btn" onClick={onQuiz}>查看本机自测卷</button> : null}</div> : null}
  </section>;
}
