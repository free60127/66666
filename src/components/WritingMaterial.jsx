import { useMemo } from 'react'
import { splitWritingMaterial } from '../writingMaterial.js'

export default function WritingMaterial({ text, className = '' }) {
  const parts = useMemo(() => splitWritingMaterial(text), [text]);
  return <div className={'writing-material ' + className}>
    {parts.map((part, index) => <section className="writing-material-section" key={index}>
      {part.label ? <h4 className="writing-material-label">{part.label}</h4> : null}
      {part.title ? <h5 className="writing-material-title">{part.title}</h5> : null}
      {part.paragraphs.map((paragraph, paragraphIndex) => <p className="writing-material-p" key={paragraphIndex}>{paragraph}</p>)}
    </section>)}
  </div>;
}
