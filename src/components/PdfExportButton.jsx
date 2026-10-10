import React, { useEffect, useRef, useState } from 'react';
import { Download } from 'lucide-react';
import { exportDate, safeFilename } from '../homeworkExport.js';
import { optionLabel, optionText } from '../quizGrade.js';

export default function PdfExportButton({ result, quiz, disabled = false }) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [file, setFile] = useState(null);
  const [url, setUrl] = useState('');
  const operation = useRef(0);
  const urlRef = useRef('');
  const lock = useRef(false);
  useEffect(() => {
    const generation = operation;
    operation.current++;
    lock.current = false; setBusy(false); setFile(null); setUrl(''); setMessage('');
    if (urlRef.current) URL.revokeObjectURL(urlRef.current);
    urlRef.current = '';
    return () => { generation.current++; if (urlRef.current) URL.revokeObjectURL(urlRef.current); };
  }, [result, quiz]);
  const generate = async () => {
    if (lock.current || disabled) return;
    lock.current = true; setBusy(true); setMessage('正在准备 PDF（首次需下载中文字体）…');
    const id = ++operation.current;
    try {
      const { createHomeworkPdf, loadReportFont } = await import('../homeworkPdf.js');
      const font = await loadReportFont();
      if (id !== operation.current) return;
      setMessage('正在生成 PDF…');
      const title = result?.workTitle || result?.title || quiz?.title || '回译作业';
      let blocks;
      if (quiz) {
        blocks = [{ kind: 'title', text: title }, { kind: 'body', text: `共 ${quiz.questions?.length || 0} 题` }];
        for (const [i, q] of (quiz.questions || []).entries()) {
          blocks.push({ kind: 'subheading', text: `${i + 1}. ${q.question || ''}` });
          for (const [j, option] of (q.options || []).entries()) blocks.push({ kind: 'body', text: `${optionLabel(option, j)}. ${optionText(option)}` });
          blocks.push({ kind: 'body', text: '作答：____________________________' });
        }
        blocks.push({ kind: 'section', text: '答案与解析' });
        for (const [i, q] of (quiz.questions || []).entries()) {
          blocks.push({ kind: 'subheading', text: `${i + 1}. ${q.answer || '（未提供答案）'}` });
          if (q.explanation) blocks.push({ kind: 'body', text: q.explanation });
        }
      }
      const bytes = await createHomeworkPdf({ result, score: result?.overall?.score, at: result?.attemptTime || Date.now() }, '', title, font, blocks);
      if (id !== operation.current) return;
      const score = typeof result?.overall?.score === 'number' ? `_${result.overall.score}` : '';
      const pdf = new File([bytes], `${safeFilename(title)}${score}_${exportDate(result?.attemptTime)}.pdf`, { type: 'application/pdf' });
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
      const href = URL.createObjectURL(pdf); urlRef.current = href;
      setFile(pdf); setUrl(href);
      const a = document.createElement('a'); a.href = href; a.download = pdf.name;
      document.body.appendChild(a); a.click(); a.remove();
      setMessage(/MicroMessenger/i.test(navigator.userAgent)
        ? 'PDF 已生成。若微信未开始下载，请点右上角“…”选择在浏览器打开，再下载。'
        : 'PDF 已生成。若未开始下载，请点击“下载 / 打开 PDF”，或使用“保存 / 分享 PDF”。');
    } catch (error) {
      if (id === operation.current) setMessage(error.message || 'PDF 生成失败，请重试');
    } finally {
      if (id === operation.current) { lock.current = false; setBusy(false); }
    }
  };
  let canShare = false;
  try { canShare = Boolean(file && navigator.canShare?.({ files: [file] })); } catch { /* unsupported browser */ }
  const share = async () => {
    try { await navigator.share({ files: [file], title: file.name }); }
    catch (error) { if (error.name !== 'AbortError') setMessage('分享未成功，请使用下载链接保存 PDF。'); }
  };
  return <>
    <button className="ghost-btn" disabled={disabled || busy} onClick={generate}><Download size={15} />{busy ? '生成 PDF…' : '导出 PDF'}</button>
    {url && <a className="ghost-btn pdf-download-link" href={url} download={file?.name} target="_blank" rel="noreferrer">下载 / 打开 PDF</a>}
    {canShare && <button className="ghost-btn" onClick={share}>保存 / 分享 PDF</button>}
    {message && <span className="share-tip pdf-export-status" role="status">{message}</span>}
  </>;
}
