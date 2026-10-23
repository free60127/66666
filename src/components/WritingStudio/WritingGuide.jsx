import { useState } from 'react'
import { Check, ChevronDown, LoaderCircle, WandSparkles } from 'lucide-react'

function ReferencePattern({ children }) {
  return (
    <details className="ws-guide-pattern">
      <summary><span className="ws-pattern-show">查看参考句式</span><span className="ws-pattern-hide">收起参考句式</span></summary>
      <p>{children}</p>
    </details>
  );
}

export default function WritingGuide({
  brief, status, error, open, onToggle, activeSeg, paragraphLabel, angle, onGenerate, disabled,
}) {
  const [choosing, setChoosing] = useState(false);
  const [customAngle, setCustomAngle] = useState(angle || '');
  // 生成完成后 angle 会更新为 AI 选定的角度——输入框跟着同步一次（用户自己正在打字时不覆盖）
  const [seenAngle, setSeenAngle] = useState(angle || '');
  if ((angle || '') !== seenAngle) {
    setSeenAngle(angle || '');
    setCustomAngle(angle || '');
  }
  const running = status === 'running';
  const locked = disabled || running;
  const paragraph = brief?.paragraphs[activeSeg];
  const generate = (value) => { setChoosing(false); onGenerate(value); };

  return (
    <section className={'ws-brief' + (open ? ' open' : '')} aria-label="AI 写作引导">
      <button className="ws-brief-toggle" onClick={onToggle} aria-expanded={open}>
        <WandSparkles size={16} />AI 写作引导
        <span className="ws-guide-caption">选角度 · 理思路 · 看句式</span>
        <ChevronDown size={15} className={'ws-caret' + (open ? ' rot' : '')} />
      </button>
      {open ? (
        <div className="ws-brief-body" aria-busy={running}>
          {running ? <p className="muted small ws-brief-loading" role="status"><LoaderCircle className="spin" size={14} />正在生成四段指导，请稍候…</p> : null}
          {status === 'error' ? (
            <div className="ws-guide-error">
              <p className="small" role="alert">{error}</p>
              <button className="ghost-btn sm" onClick={() => onGenerate(angle)} disabled={locked}>重试</button>
              {brief ? <p className="muted small">以下保留上一版指导。</p> : null}
            </div>
          ) : null}
          {brief ? (
            <div className="ws-guide-angle">
              <div><span className="ws-guide-label">本次立场 / 角度</span><strong>{brief.selectedAngle || '按题目要求展开'}</strong></div>
              <button className="ghost-btn sm" onClick={() => setChoosing((value) => !value)} aria-expanded={choosing} disabled={locked}>
                切换立场 / 角度<ChevronDown size={14} />
              </button>
            </div>
          ) : <p className="muted small ws-guide-intro">先选立场或分析角度，AI 会给出各段思路、关键词和可展开的参考句式。留空可由 AI 推荐。</p>}
          {(!brief || choosing) && !running ? (
            <div className="ws-angle-picker">
              {brief?.angles.length ? <div className="ws-angle-options" aria-label="可选立场与分析角度">
                {brief.angles.map((option) => (
                  <button key={option} onClick={() => generate(option)} disabled={locked} aria-pressed={option === brief.selectedAngle}>
                    <span>{option}</span>{option === brief.selectedAngle ? <Check size={16} /> : null}
                  </button>
                ))}
              </div> : null}
              <label className="ws-custom-angle-label" htmlFor="ws-custom-angle">{brief ? '也可以自定角度' : '我的立场或分析角度（可选）'}</label>
              <div className="ws-custom-angle">
                <input id="ws-custom-angle" value={customAngle} maxLength={400} disabled={locked}
                  onChange={(event) => setCustomAngle(event.target.value)} placeholder="例如：肯定现状，再提出改善建议" />
                <button className="primary-btn sm" onClick={() => generate(customAngle.trim())} disabled={locked}>
                  {brief ? '按此角度生成' : '生成本题写作指导'}
                </button>
              </div>
              {brief ? <p className="muted small">选择后会重新生成四段指导，已写作文会保留。</p> : null}
            </div>
          ) : null}
          {brief ? (
            <div className="ws-brief-content">
              <details className="ws-guide-overview">
                <summary>审题要点与全文安排</summary>
                {brief.stance ? <p className="small">{brief.stance}</p> : null}
                <ol className="small">{brief.outline.map((item, index) => item ? <li key={index}>{item}</li> : null)}</ol>
                {brief.pitfalls.length ? <><h4>避坑提醒</h4><ul className="small">{brief.pitfalls.map((item, index) => <li key={index}>{item}</li>)}</ul></> : null}
              </details>
              {paragraph?.steps.length ? (
                <section className="ws-guide-paragraph" key={JSON.stringify(paragraph)} aria-label={paragraphLabel + '写作思路'}>
                  <h4>{paragraphLabel}思路</h4>
                  <p className="ws-guide-goal small">{paragraph.goal}</p>
                  <ol className="ws-guide-steps">
                    {paragraph.steps.map((step, index) => (
                      <li key={index}>
                        <span className="ws-guide-number" aria-hidden="true">{index + 1}</span>
                        <div className="ws-guide-step">
                          {step.idea ? <p className="ws-guide-idea">{step.idea}</p> : null}
                          {step.keywords.length ? <div className="ws-guide-keywords">{step.keywords.map((word) => <span key={word}>{word}</span>)}</div> : null}
                          {step.pattern ? <ReferencePattern>{step.pattern}</ReferencePattern> : null}
                        </div>
                      </li>
                    ))}
                  </ol>
                </section>
              ) : null}
              {brief.patterns.length ? <section className="ws-guide-legacy-patterns"><h4>参考句式</h4>{brief.patterns.map((pattern, index) => <ReferencePattern key={index}>{pattern}</ReferencePattern>)}</section> : null}
              <button className="ghost-btn sm ws-guide-regenerate" onClick={() => onGenerate(brief.selectedAngle || angle)} disabled={locked}>换一版指导</button>
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
