#!/usr/bin/env node
/**
 * hook 作用域检查：App 里从 hook 解构出来的名字，有没有在**声明之前**被用掉。
 *
 * 为什么需要这个：React 组件里所有 hook 都在同一次函数调用里顺序执行，
 * `const { a } = useX()` 之前出现 `a`（哪怕只是传进另一个 hook 的参数对象）就是
 * 运行时的 `ReferenceError: Cannot access 'a' before initialization` ——
 * 页面直接白屏。而这条链路上：
 *   · tsc / vite build 查不出来（不校验跨语句的作用域顺序）；
 *   · ESLint 的 no-undef 也查不出来（名字确实声明了，只是晚了几十行）；
 *   · 单元测试更查不出来（不渲染组件）。
 * 本次重构里它真实发生过两次（setMatchedLesson、matchedLesson），只靠浏览器 e2e 才发现。
 *
 * 判定规则（保守，宁可漏报不要误报）：
 *   · 只看 App() 函数体内、hook 解构块之前的那段；
 *   · 跳过注释行、import 行；
 *   · 跳过对象字面量的 key（`name:`）、属性访问（`.name`）；
 *   · 跳过箭头函数体内（`=>` 之后的）—— 那是回调，调用时声明早已执行完。
 *
 * 跑法：node tools/check-hook-scope.mjs [文件…]（默认 src/App.jsx）
 */
import fs from 'node:fs';

const files = process.argv.slice(2).filter((a) => !a.startsWith('-'));
const targets = files.length ? files : ['src/App.jsx'];

const HOOK_CALL = /^\s*\} = (use[A-Z]\w*)\(\{/;
const DESCRUCT_START = /^\s*const \{/;

function commentLine(line) {
  const t = line.trim();
  return t.startsWith('//') || t.startsWith('*') || t.startsWith('/*') || t.startsWith('import ');
}

/** 收集 App 函数体的行区间 [start, end]（0-based，含端点） */
function appBody(lines) {
  const s = lines.findIndex((l) => /^function App\(\)\s*\{/.test(l));
  if (s < 0) return null;
  for (let i = s + 1; i < lines.length; i += 1) {
    if (lines[i] === '}') return [s, i];
  }
  return [s, lines.length - 1];
}

/** 命中的位置是不是「延迟执行」的（对象 key / 属性访问 / 闭包体内） */
function isDeferred(line, index, name) {
  const before = line.slice(0, index);
  const after = line.slice(index + name.length);
  if (/^\s*:/.test(after)) return true;            // { name: ... } 对象 key
  if (/[.\w$]$/.test(before)) return true;         // foo.name / foo$name
  if (/=>/.test(before)) return true;              // 箭头函数体内（回调，调用时声明已执行完）
  return false;
}

let failed = 0;
for (const file of targets) {
  if (!fs.existsSync(file)) { console.error(`跳过（不存在）：${file}`); continue; }
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
  const body = appBody(lines);
  if (!body) { console.error(`跳过（找不到 function App）：${file}`); continue; }
  const [bodyStart] = body;

  lines.forEach((line, i) => {
    if (i <= bodyStart || !HOOK_CALL.test(line)) return;
    const hook = line.match(HOOK_CALL)[1];
    let start = i;
    while (start > bodyStart && !DESCRUCT_START.test(lines[start])) start -= 1;
    const block = lines.slice(start, i + 1).join(' ').split(`= ${hook}`)[0];
    const names = new Set(block.match(/[A-Za-z_$][\w$]*/g) || []);
    names.delete('const');

    for (const name of names) {
      const re = new RegExp(`\\b${name.replace(/\$/g, '\\$')}\\b`);
      for (let j = bodyStart + 1; j < start; j += 1) {
        if (commentLine(lines[j])) continue;
        const m = re.exec(lines[j]);
        if (!m || isDeferred(lines[j], m.index, name)) continue;
        console.error(`${file}:${j + 1}  「${name}」由 ${hook}（第 ${start + 1} 行）提供，却在第 ${j + 1} 行就被用了`
          + ` —— 声明前引用＝运行时 TDZ，页面白屏。把它挪到该 hook 之后，或用 ref 透传。`);
        console.error(`        ${lines[j].trim().slice(0, 120)}`);
        failed += 1;
        break;
      }
    }
  });
}

if (failed) {
  console.error(`\n❌ hook 作用域检查未通过：${failed} 处声明前引用`);
  process.exit(1);
}
console.log(`✅ hook 作用域检查通过（${targets.length} 个文件）`);
