/**
 * QA 探针：模拟手机端 / 电脑端用户操作，把"看着像 bug"的地方**量出来**。
 *
 * 跑法：
 *   node tools/qa-probe-mobile-desktop.mjs
 * 需要 tools/shotter/node_modules 里的 playwright（与 e2e-b6b7.mjs 同一套）。
 *
 * 与 e2e-b6b7.mjs 的分工：那个跑"功能是否正确"，这个跑"布局/交互在真实设备尺寸下是否成立"。
 */
import http from 'node:http';
import { spawn } from 'node:child_process';

let chromium;
try {
  ({ chromium } = await import('file:///D:/AI/66666-main/tools/shotter/node_modules/playwright/index.mjs'));
} catch {
  console.error('缺少 playwright：cd tools/shotter && npm i');
  process.exit(2);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PORT = Number(process.env.PROBE_PORT || 8913);
const BASE = process.env.BASE || `http://127.0.0.1:${PORT}/`;

/* ---------- 后端 + mock 模型 ---------- */
let server = null;
if (!process.env.BASE) {
  server = spawn(process.execPath, ['server/index.mjs'], {
    env: { ...process.env, PORT: String(PORT), AI_BASE_URL: 'http://127.0.0.1:9878/v1', AI_API_KEY: 'mock-probe', ALLOW_PRIVATE_BASE_URL: '1' },
    stdio: 'ignore',
  });
  let up = false;
  for (let i = 0; i < 40 && !up; i += 1) {
    try { up = (await fetch(`http://127.0.0.1:${PORT}/api/health`)).ok; } catch { /* 等 */ }
    if (!up) await sleep(500);
  }
  if (!up) { console.error('后端启动超时'); process.exit(1); }
}

const DATA = {
  title: 'Lesson 18 · He often does this!',
  chinese: '我在一家乡村小酒店吃过午饭后，就找我的提包。',
  draft: 'I was searching my bag after having lunch at a little village bar.',
  ai: 'After having lunch at a village pub, I looked for my bag.',
  original: 'After I had had lunch at a village pub, I looked for my bag.',
  overall: { score: 86, issues: 2, summary: '总体不错。', highlights: ['句式完整'], advice: ['复习 search for'] },
  // 故意塞一个超长 token：真实模型输出偶尔会有长词/URL，用来测窄屏横向溢出
  sentences: [{
    cn: '我在一家乡村小酒店吃过午饭后，就找我的提包。',
    draft: 'I was searching my bag after having lunch at a little village bar. Pneumonoultramicroscopicsilicovolcanoconiosis https://example.com/a/very/long/path/that/never/ends/anywhere',
    ai: 'After having lunch at a village pub, I looked for my bag.',
    original: 'After I had had lunch at a village pub, I looked for my bag.',
    findings: [
      { category: '拼写', from: 'searched', to: 'looked for', level: 'error', explanation: '搭配错误：search 是及物动词，search sth 意为搜查某处' },
      { category: '地道程度', from: 'boss', to: 'landlord', level: 'improve', explanation: '更地道' },
    ],
  }],
  vocabularyNotes: [{ word: 'look for', phonetic: '/lʊk fɔː/', type: '短语', meaning: '寻找', note: '比 search 更常用', examples: [{ en: 'I looked for my bag.', example: '我在找包。' }] }],
  idiomHighlights: [{ idiom: 'have a good meal', common: 'eat well', explanation: '吃得好', example: 'Did you have a good meal?', situation: '餐厅寒暄' }],
};
const mock = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    const payload = JSON.parse(body || '{}');
    const first = (payload.messages || []).find((m) => m.role === 'user');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    if (first && Array.isArray(first.content)) { res.end(JSON.stringify({ choices: [{ message: { content: 'mock ocr' } }] })); return; }
    res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(DATA) } }] }));
  });
});
await new Promise((r) => mock.listen(9878, '127.0.0.1', r));

/* ---------- 断言 ---------- */
const R = [];
const ok = (n, c, d = '') => { R.push({ n, c, d }); console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${d ? '  — ' + d : ''}`); };
const note = (s) => console.log(`      ${s}`);

const browser = await chromium.launch();

/** 手机上侧栏是 fixed 浮层，会盖住顶栏按钮 —— 点顶栏东西之前先收起它 */
async function ensureSidebarClosed(page) {
  const open = await page.evaluate(() => {
    const s = document.querySelector('.sidebar');
    if (!s) return false;
    const cs = getComputedStyle(s);
    if (cs.display === 'none' || cs.position !== 'fixed') return false;
    return s.getBoundingClientRect().width > 0;
  });
  if (!open) return;
  const btn = await page.$('.sidebar-close');
  if (btn) await btn.click().catch(() => {});
  else await page.keyboard.press('Escape');
  await sleep(400);
}

/** 打开手机端侧栏（已开则不动；直接点 .side-toggle 会被已展开的侧栏挡住） */
async function openSidebar(page) {
  const state = await page.evaluate(() => {
    const s = document.querySelector('.sidebar');
    if (!s) return 'missing';
    const cs = getComputedStyle(s);
    if (cs.display === 'none') return 'closed';
    if (cs.position === 'fixed') return 'open';                       // 手机：浮层形态，width>0 即已展开
    return parseFloat(cs.marginLeft) < 0 ? 'collapsed' : 'open';      // 桌面：靠 margin-left:-268px 收起
  });
  if (state === 'open' || state === 'missing') return;
  const t = await page.$('.side-toggle');
  if (t) await t.click().catch(() => {});
  await sleep(400);
}

/** 关掉任何残留弹窗（Escape 是已实现的关闭路径） */
async function closeAnyModal(page) {
  for (let i = 0; i < 3; i += 1) {
    if (!(await page.$('.modal-mask'))) return;
    await page.keyboard.press('Escape');
    await sleep(250);
  }
  if (await page.$('.modal-mask')) {
    await page.evaluate(() => document.querySelectorAll('.modal-mask').forEach((m) => m.remove()));
    await sleep(150);
  }
}

/** 在指定设备上下文中跑一轮检查 */
async function runDevice(label, ctxOpts) {
  console.log(`\n========== ${label} ==========`);
  const ctx = await browser.newContext(ctxOpts);
  const page = await ctx.newPage();
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  // 删库 / 删课 / 清空收藏都走 window.confirm，而 Playwright 默认是"取消"——
  // 不接这一手，删除动作根本不会发生，后面的墓碑断言会假失败
  page.on('dialog', (d) => d.accept());
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));

  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.status-chip', { timeout: 30000 });
  await page.waitForFunction(() => /AI 已配置/.test(document.querySelector('.status-chip')?.textContent || ''), null, { timeout: 60000 });
  const isMobile = (ctxOpts.viewport?.width || 0) <= 900;
  // ⚠️ 必须拿"设备宽"比较，不能用 window.innerWidth：
  // 移动端模拟下内容一旦溢出，innerWidth 会跟着变宽（390 → 437），
  // 于是 scrollWidth === innerWidth 永远成立 —— 这个检查会假通过。
  const DEVICE_W = ctxOpts.viewport?.width || 0;

  /* ---- 1. 横向溢出 ---- */
  const hOverflow = await page.evaluate(() => ({
    doc: document.documentElement.scrollWidth, win: window.innerWidth, visual: window.visualViewport ? Math.round(window.visualViewport.width) : null,
  }));
  ok(`[${label}] 首屏无横向滚动`, hOverflow.doc <= DEVICE_W + 1,
    `scrollWidth=${hOverflow.doc} / 设备宽=${DEVICE_W}（window.innerWidth=${hOverflow.win}，visualViewport=${hOverflow.visual}）`);

  /* ---- 2. 触摸目标尺寸（仅移动端） ---- */
  if (isMobile) {
    const small = await page.evaluate(() => {
      const sel = '.icon-btn, .fav-star, .speak-btn, .ghost-btn, .glance-jump button, .score-breakdown-title, .lib-add, .book-tabs button, .lesson-item, .folder-btn, .chip-btn';
      const out = [];
      document.querySelectorAll(sel).forEach((el) => {
        const r = el.getBoundingClientRect();
        if (r.width === 0 && r.height === 0) return;
        if (r.width < 44 || r.height < 44) {
          out.push({ cls: el.className.toString().slice(0, 40), t: (el.textContent || '').trim().slice(0, 12), w: Math.round(r.width), h: Math.round(r.height) });
        }
      });
      return out.slice(0, 25);
    });
    ok(`[${label}] 触摸目标 ≥44px`, small.length === 0, small.length ? `${small.length} 处偏小，例如 ` + small.slice(0, 6).map((s) => `${s.cls || s.t}(${s.w}×${s.h})`).join(' / ') : '');
  }

  /* ---- 3. 输入控件字号（iOS 自动放大阈值 16px） ---- */
  if (isMobile) {
    const tiny = await page.evaluate(() => {
      const out = [];
      document.querySelectorAll('input, textarea, select').forEach((el) => {
        const fs = parseFloat(getComputedStyle(el).fontSize);
        if (fs < 16) out.push({ tag: el.tagName, cls: el.className.toString().slice(0, 30), fs });
      });
      return out;
    });
    ok(`[${label}] 输入控件字号 ≥16px（防 iOS 聚焦放大）`, tiny.length === 0, tiny.length ? JSON.stringify(tiny.slice(0, 5)) : '');
  }

  /* ---- 4. toast 提示条几何（重点：手机端是否被拉伸满屏） ---- */
  {
    // 触发路径：「新建回译作业」→ 弹窗里点「不保存，直接新建」→ toast「已新建一份空白作业」
    await openSidebar(page);
    const newBtn = page.locator('button', { hasText: '新建回译作业' }).first();
    if (await newBtn.count()) {
      await newBtn.click();
      await page.waitForSelector('.modal-mask', { timeout: 5000 }).catch(() => {});
      const discard = page.locator('button', { hasText: /不保存，直接新建|新建空白作业/ }).first();
      if (await discard.count()) { await discard.click(); } else { await closeAnyModal(page); }
      await page.waitForSelector('.fav-tip.toast', { timeout: 5000 }).catch(() => {});
      const box = await page.evaluate(() => {
        const el = document.querySelector('.fav-tip.toast');
        if (!el) return null;
        const r = el.getBoundingClientRect();
        const cs = getComputedStyle(el);
        // 这一片区域上有哪些元素会被它挡住（判断是否吃掉点击）
        const cx = Math.round(r.x + r.width / 2);
        const cy = Math.round(r.y + r.height - 4);
        const top = document.elementFromPoint(cx, Math.min(cy, window.innerHeight - 1));
        return {
          x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height),
          top: cs.top, bottom: cs.bottom, pe: cs.pointerEvents, z: cs.zIndex,
          blocker: top ? top.className.toString().slice(0, 40) || top.tagName : null,
        };
      });
      if (box) {
        const vh = await page.evaluate(() => window.innerHeight);
        const ratio = box.h / vh;
        ok(`[${label}] toast 尺寸合理（不该占掉半屏）`, ratio < 0.35 && box.w < 700,
          `toast ${box.w}×${box.h}，视口高 ${vh}，占比 ${(ratio * 100).toFixed(0)}% | computed top=${box.top} bottom=${box.bottom} pointer-events=${box.pe} z=${box.z}`);
        note(`toast 覆盖 y=${box.y}→${box.y + box.h}；该区域最上层元素 = ${box.blocker}`);
        // 提示条是纯文字（role=status），不该吃掉它盖住那片区域的点击
        ok(`[${label}] toast 不吃点击（pointer-events: none）`, box.blocker !== 'fav-tip toast',
          `toast 区域最上层元素 = ${box.blocker}`);
      } else {
        ok(`[${label}] toast 能出现`, false, '没等到 .fav-tip.toast');
      }
      await sleep(3300); // 等它自己消失，别干扰后续
    }
  }
  await closeAnyModal(page);

  /* ---- 5. 弹窗：宽度是否超出遮罩内容盒 / 打开时背景是否被锁滚 ---- */
  {
    await closeAnyModal(page);
    await ensureSidebarClosed(page);
    const favBtn = page.locator('button', { hasText: /收藏夹/ }).first();
    if (await favBtn.count()) {
      await favBtn.click();
      await page.waitForSelector('.modal-mask', { timeout: 5000 }).catch(() => {});
      const m = await page.evaluate(() => {
        const mask = document.querySelector('.modal-mask');
        if (!mask) return null;
        const modal = mask.querySelector('.modal');
        const cs = getComputedStyle(mask);
        const padL = parseFloat(cs.paddingLeft), padR = parseFloat(cs.paddingRight);
        const cw = mask.clientWidth - padL - padR;         // 遮罩内容盒宽
        const mr = modal.getBoundingClientRect();
        return {
          maskW: mask.clientWidth, contentW: Math.round(cw), modalW: Math.round(mr.width),
          overflowX: mask.scrollWidth > mask.clientWidth, maskScrollX: mask.scrollWidth, maskClientX: mask.clientWidth,
          bodyOverflow: getComputedStyle(document.body).overflow,
          maskOverscroll: getComputedStyle(mask).overscrollBehavior,
        };
      });
      if (m) {
        ok(`[${label}] 弹窗不超出遮罩内容盒`, m.modalW <= m.contentW + 1,
          `弹窗 ${m.modalW}px vs 内容盒 ${m.contentW}px（遮罩 ${m.maskW}px）→ 窗外可点区域每侧约 ${Math.max(0, Math.round((m.maskW - m.modalW) / 2))}px`);        ok(`[${label}] 遮罩无横向滚动`, !m.overflowX, `scrollWidth=${m.maskScrollX} clientWidth=${m.maskClientX}`);
        // 滚动穿透：不看 CSS 属性，直接量"在遮罩上滚一下，背景有没有动"
        const beforeY = await page.evaluate(() => Math.round(window.scrollY || document.documentElement.scrollTop || 0));
        const beforeBox = await page.evaluate(() => {
          const box = document.querySelector('.editor, .result');
          return box ? Math.round(box.scrollTop) : 0;
        });
        await page.mouse.move(Math.round(DEVICE_W / 2), 120);
        await page.mouse.wheel(0, 600);
        await sleep(450);
        const afterY = await page.evaluate(() => Math.round(window.scrollY || document.documentElement.scrollTop || 0));
        const afterBox = await page.evaluate(() => {
          const box = document.querySelector('.editor, .result');
          return box ? Math.round(box.scrollTop) : 0;
        });
        const leaked = afterY !== beforeY || afterBox !== beforeBox;
        ok(`[${label}] 弹窗打开时背景滚不动（防滚动穿透）`, !leaked,
          `页面 scrollY ${beforeY}→${afterY}，内部容器 scrollTop ${beforeBox}→${afterBox} | body overflow=${m.bodyOverflow} mask overscroll=${m.maskOverscroll}`);
      } else {
        note('没等到收藏夹弹窗，跳过弹窗几何检查');
      }
      await page.keyboard.press('Escape');
      await sleep(300);
    }
  }
  await closeAnyModal(page);

  /* ---- 6. 打开弹窗不该把背景弹回顶部，关闭后要还原 ---- */
  {
    await closeAnyModal(page);
    await ensureSidebarClosed(page);
    const readPos = () => page.evaluate(() => ({
      page: Math.round(window.scrollY || document.documentElement.scrollTop || 0),
      inner: Math.round(document.querySelector('.editor, .result')?.scrollTop || 0),
    }));
    // 先把背景滚下去（手机滚整页，桌面滚内部容器）
    await page.evaluate(() => {
      const box = document.querySelector('.editor, .result');
      if (box && box.scrollHeight > box.clientHeight) box.scrollTop = 700;
      window.scrollTo(0, 700);
    });
    await sleep(400);
    const before = await readPos();
    // 程序化点击：locator.click() 会先把按钮滚进视口，那会污染"背景位置"的测量
    await page.evaluate(() => {
      const b = [...document.querySelectorAll('button')].find((x) => /收藏夹/.test(x.textContent));
      if (b) b.click();
    });
    await page.waitForSelector('.modal-mask', { timeout: 5000 }).catch(() => {});
    await sleep(450);
    const during = await readPos();
    ok(`[${label}] 开弹窗不把背景弹回顶部`, during.page === before.page && during.inner === before.inner,
      `页面 y ${before.page}→${during.page}，内部 ${before.inner}→${during.inner}`);
    await page.keyboard.press('Escape');
    await sleep(500);
    const after = await readPos();
    ok(`[${label}] 关弹窗后背景位置还原`, after.page === before.page && after.inner === before.inner,
      `页面 y ${before.page}→${after.page}，内部 ${before.inner}→${after.inner}`);
  }

  /* ---- 7. 生成一份结果，检查结果页 ---- */
  await closeAnyModal(page);
  await ensureSidebarClosed(page);
  await page.fill('.big-textarea >> nth=0', DATA.chinese).catch(() => {});
  await page.fill('.big-textarea >> nth=1', DATA.draft).catch(() => {});
  await page.click('.primary-btn.big');
  await page.waitForSelector('.result-sheet', { timeout: 120000 });
  await page.waitForFunction(() => !document.querySelector('.busy, .progress'), null, { timeout: 120000 }).catch(() => {});
  await sleep(600);

  const resOverflow = await page.evaluate(() => {
    const offenders = [];
    const vw = window.innerWidth;
    document.querySelectorAll('.sheet *, .result *').forEach((el) => {
      const r = el.getBoundingClientRect();
      if (r.width === 0) return;
      if (r.right > vw + 2 || r.left < -2) {
        offenders.push({ cls: el.className.toString().slice(0, 44), tag: el.tagName, right: Math.round(r.right), left: Math.round(r.left) });
      }
    });
    return { doc: document.documentElement.scrollWidth, win: vw, offenders: offenders.slice(0, 10) };
  });
  ok(`[${label}] 结果页无横向溢出（含超长英文 token）`, resOverflow.doc <= DEVICE_W + 1,
    `scrollWidth=${resOverflow.doc} / 设备宽=${DEVICE_W}（innerWidth=${resOverflow.win}）` + (resOverflow.offenders.length ? ' | 越界元素: ' + resOverflow.offenders.map((o) => `${o.tag}.${o.cls}[${o.left}→${o.right}]`).join(' ') : ''));

  /* ---- 8. 回到顶部按钮：内部滚动是否误触发 ---- */
  if (isMobile) {
    await openSidebar(page);
    await page.evaluate(() => { const l = document.querySelector('.lesson-list'); if (l) l.scrollTop = 600; });
    await sleep(300);
    const { btt, sidebarOpen } = await page.evaluate(() => {
      const b = document.querySelector('.back-to-top');
      const s = document.querySelector('.sidebar');
      const br = b && b.getBoundingClientRect();
      const sr = s && s.getBoundingClientRect();
      return {
        btt: b ? { z: getComputedStyle(b).zIndex, x: Math.round(br.x), y: Math.round(br.y), overSidebar: !!(sr && sr.width > 0 && br.left < sr.right && br.top < sr.bottom) } : null,
        sidebarOpen: !!(sr && sr.width > 0),
      };
    });
    if (sidebarOpen) {
      ok(`[${label}] 滚侧栏课表不该弹出「回到顶部」`, !btt, btt ? `侧栏课表滚动 600px 后按钮出现（z=${btt.z}，位置 ${btt.x},${btt.y}，${btt.overSidebar ? '且压在侧栏上' : '在侧栏之外'}）` : '');
    } else {
      note('侧栏没打开，跳过该检查');
    }
    // 关掉侧栏后再看按钮是否还在
    await ensureSidebarClosed(page);
    const after = await page.evaluate(() => !!document.querySelector('.back-to-top'));
    if (after) note('⚠️ 关闭侧栏后「回到顶部」仍然挂在屏幕上（只有下一次 scroll 事件才会复位）');
  }

  /* ---- 9. 触屏：自建课文库的「删除」按钮必须可见（原来靠 hover 揭示，手机上永远看不到） ---- */
  if (isMobile) {
    await closeAnyModal(page);
    await ensureSidebarClosed(page);
    // 第 8 步结束时停在结果页，而「保存到课文库」在编辑页上 —— 先切回去
    if (!(await page.$('.big-textarea'))) {
      await page.locator('.result-toolbar >> text=返回编辑').first().click().catch(() => {});
      await page.waitForSelector('.big-textarea', { timeout: 8000 }).catch(() => {});
    }
    // 先真的建一个库：编辑器工具栏的「保存到课文库」
    await page.fill('.big-textarea >> nth=0', '触屏探针用的中文');
    await page.locator('button:has-text("保存到课文库")').first().click().catch(() => {});
    await page.waitForSelector('.modal', { timeout: 8000 }).catch(() => {});
    const nameInput = page.locator('.modal input[type="text"], .modal input:not([type]):not([type=radio]):not([type=checkbox])').first();
    if (await nameInput.count()) await nameInput.fill('探针库');
    await page.locator('.modal button:has-text("保存")').first().click().catch(() => {});
    await sleep(1000);
    await closeAnyModal(page);
    await openSidebar(page);

    const libDel = await page.evaluate(() => {
      const el = document.querySelector('.lib-del');
      if (!el) return { exists: false };
      const cs = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      return { exists: true, visibility: cs.visibility, display: cs.display, w: Math.round(r.width), h: Math.round(r.height) };
    });
    if (libDel.exists) {
      ok(`[${label}] 触屏下「删除课文库」按钮可见`, libDel.visibility === 'visible' && libDel.w > 0,
        `visibility=${libDel.visibility} display=${libDel.display} ${libDel.w}×${libDel.h}`);
      ok(`[${label}] 行内「改 / 删」触摸目标 ≥44px`, libDel.w >= 44 && libDel.h >= 44, `${libDel.w}×${libDel.h}`);
      // 墓碑接线：删掉库之后本机必须记下"这个库已删"，
      // 否则下一次云同步会把整个库从云端旧副本里并回来（纯函数测过，但接线没人测）
      await page.locator('.lib-del').first().click({ force: true }).catch(() => {});
      await sleep(700);
      const tomb = await page.evaluate(() => ({
        libs: localStorage.getItem('bt-libs-deleted') || '',
        lessons: localStorage.getItem('bt-lessons-deleted') || '',
      }));
      ok(`[${label}] 删库写下了墓碑（云同步不会把它并回来）`, /lib-/.test(tomb.libs), `bt-libs-deleted=${tomb.libs}`);
      // 库里每节课也要留墓碑：只记"库没了"，单节课仍会从别的设备的旧副本里"半复活"
      ok(`[${label}] 删库时库里的课文也进了墓碑`, /\|lsn-/.test(tomb.lessons), `bt-lessons-deleted=${tomb.lessons}`);
    } else {
      ok(`[${label}] 触屏下「删除课文库」按钮存在`, false, '没有 .lib-del 元素（课文库没建出来？）');
    }
    await ensureSidebarClosed(page);
  }

  /* ---- 10. 底部两条提示是否重叠 ---- */
  if (isMobile) {
    const overlap = await page.evaluate(() => {
      const a = document.querySelector('.fav-tip');
      const b = document.querySelector('.wake-tip');
      if (!a || !b) return null;
      const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
      const hit = !(ra.right < rb.left || ra.left > rb.right || ra.bottom < rb.top || ra.top > rb.bottom);
      return { hit, a: [Math.round(ra.top), Math.round(ra.bottom)], b: [Math.round(rb.top), Math.round(rb.bottom)] };
    });
    if (overlap) ok(`[${label}] 底部两条提示不重叠`, !overlap.hit, `fav-tip y=${overlap.a} wake-tip y=${overlap.b}`);
    else note('当前没有同时出现两条提示，跳过重叠检查');
  }

  /* ---- 10b. 取消收藏也要留墓碑（否则下次同步又冒出来） ---- */
  {
    if (!(await page.$('.fav-star'))) {
      await page.locator('.result-toolbar >> text=返回编辑').first().click().catch(() => {});
      await sleep(300);
      await page.locator('.primary-btn.big').click().catch(() => {});
      await page.waitForSelector('.result-sheet', { timeout: 120000 }).catch(() => {});
      await page.waitForFunction(() => !document.querySelector('.busy, .progress'), null, { timeout: 120000 }).catch(() => {});
      await sleep(400);
    }
    const star = page.locator('.fav-star').first();
    if (await star.count()) {
      await star.click();                        // 先收藏
      await sleep(400);
      const idOn = await page.evaluate(() => { try { return (JSON.parse(localStorage.getItem('bt-favorites') || '[]')[0] || {}).id || ''; } catch { return ''; } });
      await star.click();                        // 再取消收藏
      await sleep(500);
      const tomb = await page.evaluate(() => localStorage.getItem('bt-favs-deleted') || '');
      ok(`[${label}] 取消收藏写下了墓碑`, Boolean(idOn) && tomb.includes(idOn), `id=${idOn} 墓碑=${tomb.slice(0, 60)}`);
    } else {
      note('结果页没有可收藏项，跳过收藏墓碑检查');
    }
  }

  /* ---- 11. 打印：编辑页 Ctrl+P 是否出白纸（用 print media 模拟） ---- */
  {
    await page.locator('.result-toolbar >> text=返回编辑').first().click().catch(() => {});
    await page.waitForSelector('.editor', { timeout: 10000 }).catch(() => {});
    await page.emulateMedia({ media: 'print' });
    const pr = await page.evaluate(() => {
      const ed = document.querySelector('.editor');
      const rs = document.querySelector('.result');
      const vis = (el) => {
        if (!el) return 0;
        const cs = getComputedStyle(el);
        if (cs.display === 'none' || cs.visibility === 'hidden') return 0;
        return el.getBoundingClientRect().height;
      };
      return { editorH: Math.round(vis(ed)), resultH: Math.round(vis(rs)), speakBtns: [...document.querySelectorAll('.speak-btn')].filter((e) => getComputedStyle(e).display !== 'none').length };
    });
    ok(`[${label}] 打印编辑页有内容（不是白纸）`, pr.editorH > 100, `editor 高度 ${pr.editorH}px, result 高度 ${pr.resultH}px`);
    await page.emulateMedia({ media: 'screen' });
  }

  /* ---- 12. 长页面下切课是否受顶栏滚走影响（手机） ---- */
  if (isMobile) {
    const reachable = await page.evaluate(() => {
      window.scrollTo(0, 99999);
      const t = document.querySelector('.side-toggle');
      const st = document.querySelector('.topbar');
      const r = st?.getBoundingClientRect();
      return { topbarTop: r ? Math.round(r.top) : null, hasToggle: !!t, scrollY: Math.round(window.scrollY) };
    });
    note(`滚到底后 topbar.top=${reachable.topbarTop}（负数=已滚出屏幕；侧栏开关在顶栏里 → 需先滚回顶部才能切课）`);
  }

  ok(`[${label}] 全程无控制台报错`, errors.length === 0, errors.slice(0, 3).join(' | '));
  await ctx.close();
}

await runDevice('手机 iPhone 13 · 390×844', { viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true, userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1' });
await runDevice('手机 安卓小屏 · 360×800', { viewport: { width: 360, height: 800 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true, userAgent: 'Mozilla/5.0 (Linux; Android 13; Pixel 6) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36' });
await runDevice('桌面 · 1440×900', { viewport: { width: 1440, height: 900 } });
await runDevice('桌面偏窄 · 932×430 (Pro Max 横屏)', { viewport: { width: 932, height: 430 } });

await browser.close();
server?.kill();
mock.close();

const fail = R.filter((r) => !r.c);
console.log(`\n============================================================`);
console.log(`${R.length - fail.length} / ${R.length} 项通过`);
if (fail.length) { console.log('\n失败项：'); fail.forEach((f) => console.log(`  ✗ ${f.n}\n      ${f.d}`)); }
process.exit(fail.length ? 1 : 0);
