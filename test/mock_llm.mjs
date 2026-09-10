import http from 'node:http';
const PORT = 9876;
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', c => body += c);
  req.on('end', () => {
    const payload = JSON.parse(body || '{}');
    const firstUser = (payload.messages || []).find(m => m.role === 'user');
    const content = firstUser?.content;
    // 视觉识别请求：content 是数组（text + image_url），返回纯文本模拟 OCR
    if (Array.isArray(content) && content.some(part => part && part.type === 'image_url')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: 'Mock OCR: The quick brown fox jumps over the lazy dog.' } }] }));
      return;
    }
    const user = content || '';
    const chinese = user.split('中文提示：')[1]?.split('学生英文初稿')[0]?.trim() || '测试中文';
    const draft = user.split('学生英文初稿：')[1]?.split('教材课文原文')[0]?.trim() || 'Test draft.';
    const sample = {
      title: 'Lesson 18 · He often does this!',
      chinese: chinese,
      draft: draft,
      ai: 'After having lunch at a village pub, I started looking for my bag. It had been gone!',
      original: 'After I had had lunch at a village pub, I looked for my bag.',
      overall: { score: 86, issues: 3, summary: '整体不错。', highlights: ['时态准确'], advice: ['复习 search for'] },
      sentences: [
        { cn: chinese.split(/\n/)[0] || chinese, draft: draft.split(/\n/)[0] || draft, ai: 'Polished sentence.', original: 'Original sentence.', findings: [
          { category: '词义', from: 'search my bag', to: 'search for my bag', level: 'error', explanation: '错误解释测试。' },
          { category: '地道程度', from: 'small bar', to: 'village pub', level: 'study', explanation: '学习点测试。' },
        ] }
      ]
    };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(sample) } }] }));
  });
});
server.listen(PORT, () => console.log('mock llm on', PORT));
