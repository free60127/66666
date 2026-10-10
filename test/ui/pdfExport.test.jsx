import React from 'react';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import PdfExportButton from '../../src/components/PdfExportButton.jsx';
import { createHomeworkPdf, loadReportFont } from '../../src/homeworkPdf.js';

vi.mock('../../src/homeworkPdf.js', () => ({ createHomeworkPdf: vi.fn(), loadReportFont: vi.fn() }));
const result = { title: '我的翻译', overall: { score: 88 }, attemptTime: Date.parse('2026-10-10T02:00:00Z') };
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('URL', { createObjectURL: vi.fn(() => 'blob:pdf-test'), revokeObjectURL: vi.fn() });
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
  loadReportFont.mockResolvedValue(new Uint8Array([1]));
  createHomeworkPdf.mockResolvedValue(new Uint8Array([37, 80, 68, 70]));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
describe('direct PDF export', () => {
  it('provides a persistent download link after generation, with score and date in the filename', async () => {
    const view = render(<PdfExportButton result={result} />);
    fireEvent.click(screen.getByRole('button', { name: '导出 PDF' }));
    const link = await screen.findByRole('link', { name: '下载 / 打开 PDF' });
    expect(link.getAttribute('download')).toBe('我的翻译_88_2026-10-10.pdf');
    expect(link.getAttribute('href')).toBe('blob:pdf-test');
    // Returning from a share sheet must not revoke a PDF unless its report changes.
    view.rerender(<PdfExportButton result={result} />);
    expect(URL.revokeObjectURL).not.toHaveBeenCalled();
    view.rerender(<PdfExportButton result={{ ...result, title: '另一份翻译' }} />);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:pdf-test');
    expect(screen.queryByRole('link')).toBeNull();
  });
  it('shows font failures and permits a successful retry', async () => {
    loadReportFont.mockRejectedValueOnce(new Error('字体下载失败，请重试'));
    render(<PdfExportButton result={result} />);
    fireEvent.click(screen.getByRole('button'));
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('字体下载失败'));
    fireEvent.click(screen.getByRole('button'));
    expect(await screen.findByRole('link')).toBeTruthy();
    expect(createHomeworkPdf).toHaveBeenCalledTimes(1);
  });
  it('exports every quiz question and a separate answer section even when answers are hidden on screen', async () => {
    render(<PdfExportButton quiz={{ title: '自测', questions: [
      { question: '选择题', options: ['A. first', 'B. second'], answer: 'B', explanation: '第二项正确' },
      { question: '翻译题', answer: 'A complete sentence.', explanation: '参考译法' },
    ] }} />);
    fireEvent.click(screen.getByRole('button'));
    await screen.findByRole('link');
    const blocks = createHomeworkPdf.mock.calls[0][4].map((b) => b.text);
    expect(blocks).toContain('A. first');
    expect(blocks).not.toContain('A. A. first');
    expect(blocks.indexOf('答案与解析')).toBeGreaterThan(blocks.indexOf('2. 翻译题'));
    expect(blocks).toContain('2. A complete sentence.');
  });
  it('cannot export unfinished streamed results', () => {
    render(<PdfExportButton result={result} disabled />);
    fireEvent.click(screen.getByRole('button'));
    expect(loadReportFont).not.toHaveBeenCalled();
  });
});
