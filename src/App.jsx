import React, { useEffect, useMemo, useRef, useState } from 'react';
import mammoth from 'mammoth/mammoth.browser.js';
import {
  ArrowLeft, BookOpen, CheckCircle2, ClipboardCopy, Download, FileText, Flame,
  LoaderCircle, PenLine, Plus, Settings, Sparkles, Upload, WandSparkles, X,
} from 'lucide-react';
import { analyze, getLessons, getLesson, getStatus, loadSettings, matchLesson, saveSettings } from './api.js';
import { DEMO_LESSON_18, DEMO_LESSONS } from './demo.js';

const LEVEL_LABEL = { error: '必须改错', improve: '润色升级', study: '对照学习' };
const CATEGORY_COLOR = {
  拼写: 'red', 标点: 'red', 语法: 'blue', 时态: 'blue', 词义: 'gold', 搭配: 'gold',
  语境: 'purple', 流畅度: 'teal', 地道程度: 'teal', 专名: 'purple', 其他: 'gray',
};

function isMarker(line) {
  return /^(标题|中文|中文译文|译文|原稿|初稿|英文初稿|学生译本|AI\s*(润色|修正)|原文|原版|逐句|详细错误|分析)/i.test(line.trim());
}

function isMostlyEnglish(line) {
  const letters = (line.match(/[A-Za-z]/g) || []).length;
  const han = (line.match(/[\u4e00-\u9fff]/g) || []).length;
  return letters >= 12 && letters > han * 2;
}

function parseAssignmentText(raw) {
  const lines = String(raw || '').split(/\r?\n/).map((line) => line.replace(/\u00a0/g, ' ').trim()).filter(Boolean);
  if (lines.length < 3) throw new Error('DOCX 内容太少，至少需要标题、中文和英文初稿三部分');
  const title = lines[0];
  const draftStart = lines.findIndex((line, index) => index > 0 && !isMarker(line) && isMostlyEnglish(line));
  if (draftStart < 0) throw new Error('没有识别到英文初稿，请确认 DOCX 中包含英文回译内容');
  const chineseLines = lines.slice(1, draftStart).filter((line) => !isMarker(line));
  const draftLines = [];
  for (const line of lines.slice(draftStart)) {
    if (isMarker(line)) break;
    draftLines.push(line);
  }
  const chinese = chineseLines.join('\n').trim();
  const draft = draftLines.join('\n').trim();
  if (!chinese || !draft) throw new Error('未能同时识别出中文提示和英文初稿');
  return { title, chinese, draft };
}

function lessonLabel(lesson) {
  return lesson ? `Lesson ${lesson.lesson} · ${lesson.title_en || lesson.title_cn}` : '';
}

function App() {
  const [settings, setSettings] = useState(loadSettings());
  const [status, setStatus] = useState(null);
  const [lessons, setLessons] = useState([]);
  const [book, setBook] = useState(2);
  const [mode, setMode] = useState('lesson');
  const [lessonId, setLessonId] = useState(18);
  const [matchedLesson, setMatchedLesson] = useState(null);
  const [title, setTitle] = useState('');
  const [chinese, setChinese] = useState('');
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [parsing, setParsing] = useState(false);
  const [fileName, setFileName] = useState('');
  const [error, setError] = useState('');
  const [result, setResult] = useState(null);
  const [view, setView] = useState('editor');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const fileRef = useRef(null);

  const refreshStatus = async () => {
    try { setStatus(await getStatus()); } catch { setStatus(null); }
  };

  useEffect(() => {
    let alive = true;
    refreshStatus();
    getLessons().then((data) => {
      if (!alive) return;
      const loaded = data.lessons || [];
      setLessons(loaded);
      if (loaded.length) selectLesson(2, loaded.some((l) => l.book === 2 && l.lesson === 18) ? 18 : loaded[0].lesson);
    }).catch(() => {
      if (!alive) return;
      const fallback = DEMO_LESSONS.map((l) => ({ ...l, book: 2 }));
      setLessons(fallback);
      selectLesson(2, 18);
    });
    return () => { alive = false; };
  }, []);

  const visibleLessons = useMemo(() => lessons.filter((l) => l.book === book), [lessons, book]);

  const selectLesson = async (nextBook, nextLesson, autoGenerate = false) => {
    setBook(nextBook);
    setLessonId(nextLesson);
    setMatchedLesson(null);
    setMode('lesson');
    try {
      const lesson = await getLesson(nextBook, nextLesson);
      setTitle(lessonLabel(lesson));
      setChinese(lesson.chinese || '');
      setDraft('');
      setMatchedLesson(lesson);
    } catch {
      setTitle(`Lesson ${nextLesson}`);
      setChinese('');
      setDraft('');
    }
    if (autoGenerate) setTimeout(() => runGenerate(nextLesson), 60);
  };

  const handleBookChange = (nextBook) => {
    const first = lessons.find((l) => l.book === nextBook);
    if (first) selectLesson(nextBook, first.lesson);
    else setBook(nextBook);
  };

  const handleDocx = async (event) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    setError('');
    setParsing(true);
    try {
      const raw = await mammoth.extractRawText({ arrayBuffer: await file.arrayBuffer() });
      const parsed = parseAssignmentText(raw.value);
      setFileName(file.name);
      setTitle(parsed.title);
      setChinese(parsed.chinese);
      setDraft(parsed.draft);
      const found = await matchLesson({ title: parsed.title, chinese: parsed.chinese });
      if (found?.match) {
        setBook(found.match.book);
        setLessonId(found.match.lesson);
        setMatchedLesson(found.match);
        setMode('lesson');
        setTitle(lessonLabel(found.match));
      } else {
        setMatchedLesson(null);
        setMode('free');
      }
    } catch (e) {
      setFileName('');
      setError(e.message || 'DOCX 读取失败');
    } finally {
      setParsing(false);
    }
  };

  const runGenerate = async (overrideLessonId) => {
    const id = overrideLessonId ?? lessonId;
    const cn = chinese.trim();
    const df = draft.trim();
    if (!cn) { setError('请先上传包含中文提示的 DOCX，或填入中文提示'); return; }
    if (!df) { setError('请先上传包含英文初稿的 DOCX，或填入英文初稿'); return; }
    setError(''); setBusy(true);
    try {
      const resp = await analyze({
        title: title.trim(), chinese: cn, draft: df,
        book: mode === 'lesson' ? book : undefined,
        lessonId: mode === 'lesson' ? id : undefined,
        baseUrl: settings.baseUrl, model: settings.model, apiKey: settings.apiKey,
      });
      setResult(resp.data);
      setView('result');
    } catch (e) {
      setError(e.message);
      setView('editor');
    } finally {
      setBusy(false);
    }
  };

  const loadDemo = () => {
    setResult(DEMO_LESSON_18);
    setView('result');
    setError('');
  };

  const copyAll = async () => {
    if (!result) return;
    const text = [
      result.title, '', '【中文译文】', result.chinese, '', '【原稿】', result.draft, '',
      '【AI 修正版】', result.ai, '', '【课文原文】', result.original, '',
      '【逐句解析】', result.overall?.summary || '', '',
      ...(result.sentences || []).flatMap((s, i) => [
        String(i + 1) + '. ' + s.cn, '原稿：' + s.draft, 'AI 修正版：' + s.ai,
        '原文：' + s.original, ...(s.findings || []).map((f) => '· [' + f.category + '] ' + f.from + ' → ' + f.to + '：' + f.explanation), '',
      ]),
    ].join('\n');
    await navigator.clipboard.writeText(text);
  };

  const onSaveSettings = () => { saveSettings(settings); refreshStatus(); setSettingsOpen(false); };

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand"><div className="brand-mark">回</div><div><strong>回译本</strong><span>BACK-TRANSLATE STUDIO</span></div></div>
        <button className="primary-btn" onClick={() => { setView('editor'); setResult(null); }}><Plus size={16} />新建回译作业</button>
        <div className="side-section">
          <div className="side-title">课文库</div>
          <div className="book-tabs">
            {[2, 3].map((n) => <button key={n} className={book === n ? 'active' : ''} onClick={() => handleBookChange(n)}>新概念 {n}</button>)}
          </div>
          <div className="lesson-list">
            {visibleLessons.length === 0 && <div className="muted">正在加载语料…</div>}
            {visibleLessons.map((l) => (
              <button key={`${l.book}-${l.lesson}`} className={'lesson-item' + (lessonId === l.lesson && book === l.book && mode === 'lesson' ? ' active' : '')}
                onClick={() => selectLesson(l.book, l.lesson)}>
                <span className="lesson-no">{String(l.lesson).padStart(2, '0')}</span>
                <span className="lesson-title">{l.title_cn || l.title_en || 'Lesson ' + l.lesson}</span>
              </button>
            ))}
          </div>
        </div>
        <div className="side-footer">
          <button className="ghost-btn" onClick={() => setSettingsOpen(true)}><Settings size={15} />AI 设置</button>
        </div>
      </aside>

      <main className="main">
        <header className="topbar">
          <div className="topbar-left"><BookOpen size={18} /><strong>{mode === 'lesson' ? '课文回译训练' : '自由回译训练'}</strong></div>
          <div className="status-chip" title={status ? (status.model + ' @ ' + status.baseUrl) : '请先启动后端 npm run server'}>
            <span className={'dot ' + (status ? 'ok' : 'err')} />
            {status ? ((status.hasKey || settings.apiKey) ? 'AI 已配置 · ' + status.model : '未配置 API Key · ' + status.model) : '后端未连接'}
            {status?.corpusLessons ? ' · ' + status.corpusLessons + ' 课' : ''}
          </div>
          <button className="ghost-btn" onClick={() => { setView('editor'); setResult(null); }}><X size={15} />编辑器</button>
        </header>

        {view === 'editor' ? (
          <section className="editor">
            <div className="upload-strip">
              <input ref={fileRef} type="file" accept=".docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document" hidden onChange={handleDocx} />
              <button className="primary-btn" onClick={() => fileRef.current?.click()} disabled={parsing}>
                {parsing ? <LoaderCircle className="spin" size={16} /> : <Upload size={16} />}
                {parsing ? '正在读取 DOCX…' : '上传 DOCX 作业'}
              </button>
              <span className="upload-name">{fileName || '上传后自动读取标题、中文和英文初稿'}</span>
            </div>
            {matchedLesson && <div className="match-banner"><BookOpen size={15} />已匹配：新概念英语第 {matchedLesson.book} 册 · Lesson {matchedLesson.lesson} · {matchedLesson.title_en}，原文将自动带入分析</div>}
            <div className="mode-tabs">
              <button className={mode === 'lesson' ? 'active' : ''} onClick={() => setMode('lesson')}><BookOpen size={15} />课文模式</button>
              <button className={mode === 'free' ? 'active' : ''} onClick={() => setMode('free')}><PenLine size={15} />自由模式</button>
            </div>
            <div className="title-field"><label>作业标题</label><input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="例如：新概念2 lesson 11" /></div>
            <div className="editor-grid">
              <div className="panel">
                <div className="panel-head"><h2>中文提示</h2><span className="hint">由 DOCX 自动读取，也可修改</span></div>
                <textarea className="big-textarea" value={chinese} onChange={(e) => setChinese(e.target.value)} placeholder="上传 DOCX 后，这里会自动填入中文译文" />
              </div>
              <div className="panel">
                <div className="panel-head"><h2>你的英文初稿</h2><span className="hint">系统将逐句检查词汇、语法、流畅度和地道程度</span></div>
                <textarea className="big-textarea" value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="上传 DOCX 后，这里会自动填入英文初稿" />
              </div>
            </div>
            {error && <div className="error-banner"><Flame size={15} />{error}<button className="link" onClick={loadDemo}>查看离线示例</button></div>}
            <div className="actions-bar">
              <button className="primary-btn big" onClick={() => runGenerate()} disabled={busy || parsing}>
                {busy ? <LoaderCircle className="spin" size={17} /> : <WandSparkles size={17} />}
                {busy ? 'AI 正在逐句分析…' : '生成完整回译训练作业'}
              </button>
              {!status?.hasKey && <button className="ghost-btn" onClick={loadDemo}><Sparkles size={15} />离线示例</button>}
              <span className="muted">生成顺序：标题 → 中文 → 原稿 → AI 修正版 → 原文 → 逐句解析</span>
            </div>
          </section>
        ) : (
          <section className="result">
            {result && <ResultSheet result={result} onBack={() => setView('editor')} onCopy={copyAll} />}
          </section>
        )}
      </main>

      {settingsOpen && (
        <div className="modal-mask" onClick={() => setSettingsOpen(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head"><h2>AI 接入设置</h2><button className="icon-btn" onClick={() => setSettingsOpen(false)}><X size={16} /></button></div>
            <label>Base URL（OpenAI 兼容）<input value={settings.baseUrl || 'https://api.deepseek.com/v1'} onChange={(e) => setSettings({ ...settings, baseUrl: e.target.value })} placeholder="https://api.deepseek.com/v1" /></label>
            <label>模型名<input value={settings.model || 'deepseek-chat'} onChange={(e) => setSettings({ ...settings, model: e.target.value })} placeholder="deepseek-chat / gpt-4o-mini / qwen-plus" /></label>
            <label>API Key<input type="password" value={settings.apiKey || ''} onChange={(e) => setSettings({ ...settings, apiKey: e.target.value })} placeholder="sk-..." /></label>
            <p className="muted small">Key 只保存在本机浏览器 localStorage，并发送给你的 localhost 后端；正式部署请改用后端 .env 的 AI_API_KEY。</p>
            <div className="modal-actions"><button className="primary-btn" onClick={onSaveSettings}>保存并重连</button><button className="ghost-btn" onClick={() => setSettingsOpen(false)}>取消</button></div>
          </div>
        </div>
      )}
    </div>
  );
}

function ResultSheet({ result, onBack, onCopy }) {
  const overall = result.overall || {};
  const sentences = result.sentences || [];
  return (
    <div className="result-sheet">
      <div className="result-toolbar">
        <button className="ghost-btn" onClick={onBack}><ArrowLeft size={15} />返回编辑</button>
        <button className="ghost-btn" onClick={onCopy}><ClipboardCopy size={15} />复制全部</button>
        <button className="ghost-btn" onClick={() => window.print()}><Download size={15} />导出 PDF</button>
      </div>
      <article className="sheet">
        <header className="sheet-title"><span className="eyebrow">BACK-TRANSLATE TRAINING · 回译训练作业</span><h1>{result.title}</h1></header>
        <Section label="中文" tone="cn"><p>{result.chinese}</p></Section>
        <Section label="原稿" tone="draft"><p>{result.draft}</p></Section>
        <Section label="AI 修正版" tone="ai"><p>{result.ai}</p></Section>
        <Section label="原文" tone="original"><p>{result.original || '（自由模式：未匹配到课文原文）'}</p></Section>
        <section className="sheet-section analysis">
          <div className="section-heading"><span className="label-dot" /><h2>逐句解析与三版本对比</h2><span className="muted small">{sentences.length} 个句群 · {overall.issues ?? 0} 项分析</span></div>
          <div className="overall-card">
            <div className="score-ring"><strong>{overall.score ?? '-'}</strong><span>综合评分</span></div>
            <div className="overall-body">
              <p>{overall.summary || ''}</p>
              <div className="chips">{(overall.highlights || []).map((h, i) => <span key={'hl' + i} className="chip"><CheckCircle2 size={13} />{h}</span>)}</div>
              <div className="advice"><strong>练习建议</strong><ul>{(overall.advice || []).map((a, i) => <li key={'ad' + i}>{a}</li>)}</ul></div>
            </div>
          </div>
          {sentences.map((sentence, i) => <SentenceCard key={'s' + i} index={i} sentence={sentence} />)}
        </section>
      </article>
    </div>
  );
}

function Section({ label, tone, children }) {
  return <section className={'sheet-section v-' + tone}><div className="section-heading"><span className="label-dot" /><h2>{label}</h2></div>{children}</section>;
}

function SentenceCard({ index, sentence }) {
  const findings = sentence.findings || [];
  return (
    <div className="sentence-card">
      <div className="sentence-head"><span className="sentence-index">{String(index + 1).padStart(2, '0')}</span><p className="sentence-cn">{sentence.cn}</p><span className="finding-count">{findings.length} 项</span></div>
      <div className="versions">
        <VersionRow label="原稿" tone="draft" text={sentence.draft} />
        <VersionRow label="AI 修正版" tone="ai" text={sentence.ai} />
        {sentence.original ? <VersionRow label="课文原文" tone="original" text={sentence.original} /> : null}
      </div>
      <div className="findings">
        {findings.map((finding, i) => <div className={'finding level-' + (finding.level || 'error')} key={'f' + i}>
          <div className="finding-top"><span className={'cat cat-' + (CATEGORY_COLOR[finding.category] || 'gray')}>{finding.category}</span><span className="level">{LEVEL_LABEL[finding.level] || finding.level}</span></div>
          <div className="finding-diff"><span className="from">{finding.from}</span><span className="arrow">→</span><strong className="to">{finding.to}</strong></div>
          <p className="finding-exp">{finding.explanation}</p>
        </div>)}
        {findings.length === 0 && <div className="muted small">该句未发现明显问题。</div>}
      </div>
    </div>
  );
}

function VersionRow({ label, tone, text }) {
  return <div className={'v-row ' + tone}><span className="v-label">{label}</span><p>{text}</p></div>;
}

export default App;
