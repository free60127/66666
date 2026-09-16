/**
 * 格式化 / 时间戳测试。
 *
 * 为什么值得单开一个文件测「一个日期戳」：导出文件名里的日期用的是
 * `new Date().toISOString().slice(0, 10)` —— 那是 **UTC** 日期。东八区用户在
 * 当地 00:00–08:00 之间导出的备份，文件名会写成前一天（实测踩到：
 * 本机 2026-09-17 06:27 导出，文件名却是 retranslate-backup-2026-09-16.json）。
 * 这种错不报错、不白屏，只是让人按文件名归档时对不上号，所以必须钉死。
 *
 * 跑法：node test/format.test.mjs
 */
import { readFileSync } from 'node:fs';
import { dayStamp, formatDay, formatDuration, formatTime } from '../src/format.js';

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
};

/* ---------- dayStamp：必须是**本地**日期 ---------- */
{
  // 用本地构造器造时间，断言它就是本地日期 —— 这条在任何时区都成立
  const localMorning = new Date(2026, 8, 17, 6, 27); // 本地 2026-09-17 06:27
  check('dayStamp 用本地日期（清晨导出不会写成前一天）', dayStamp(localMorning.getTime()) === '2026-09-17',
    `得到 ${dayStamp(localMorning.getTime())}，期望 2026-09-17`);

  // 本地当天 00:00 与 23:59 都必须算作同一天
  check('dayStamp 覆盖本地一天的起止', dayStamp(new Date(2026, 8, 17, 0, 0).getTime()) === '2026-09-17'
    && dayStamp(new Date(2026, 8, 17, 23, 59).getTime()) === '2026-09-17');

  // 月/日必须补零（文件名排序靠它）
  check('dayStamp 月日补零', dayStamp(new Date(2026, 0, 5, 12, 0).getTime()) === '2026-01-05',
    dayStamp(new Date(2026, 0, 5, 12, 0).getTime()));

  // 默认参数 = 现在
  const now = Date.now();
  check('dayStamp 缺省用当前时间', dayStamp() === dayStamp(now) && /^\d{4}-\d{2}-\d{2}$/.test(dayStamp()));

  // 明确与 UTC 做一次对比：只要本机不在 UTC，两者在"本地清晨"就该不同 ——
  // 相同说明本机时区恰好是 UTC，此时跳过（不是失败）
  const utc = new Date(localMorning.getTime()).toISOString().slice(0, 10);
  if (utc === '2026-09-17') {
    console.log('      · 本机时区接近 UTC，UTC/本地日期本例相同，跳过对比');
  } else {
    check('dayStamp 与 UTC 日期确实不同（证明不是 toISOString 的别名）', dayStamp(localMorning.getTime()) !== utc,
      `本地 ${dayStamp(localMorning.getTime())} / UTC ${utc}`);
  }
}

/* ---------- 源码层面钉死：不许再用 UTC 日期做文件名 ---------- */
{
  const files = ['src/App.jsx', 'src/hooks/useFavorites.js'];
  const offenders = [];
  for (const f of files) {
    const src = readFileSync(new URL('../' + f, import.meta.url), 'utf8');
    // 允许 as exportedAt（记录时间点），只禁"拿它当日期戳/文件名"
    src.split('\n').forEach((line, i) => {
      if (/toISOString\(\)\.slice\(0,\s*10\)/.test(line)) offenders.push(`${f}:${i + 1}`);
    });
  }
  check('源码里不再用 toISOString().slice(0,10) 当日期戳', offenders.length === 0, offenders.join(', '));
  check('导出文件名走 dayStamp()', /dayStamp\(\)/.test(readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8'))
    && /dayStamp\(\)/.test(readFileSync(new URL('../src/hooks/useFavorites.js', import.meta.url), 'utf8')));
}

/* ---------- formatTime / formatDay 边界 ---------- */
{
  check('formatTime 空值返回空串', formatTime(0) === '' && formatTime(null) === '' && formatTime(undefined) === '');
  check('formatTime 坏值不抛异常', formatTime('不是时间') === '' || typeof formatTime('不是时间') === 'string');
  check('formatDay 空值返回空串', formatDay(0) === '' && formatDay(null) === '');
  const t = new Date(2026, 8, 17, 15, 4).getTime();
  check('formatTime 显示到分钟', /9\/17/.test(formatTime(t)) && /15:04/.test(formatTime(t)), formatTime(t));
  check('formatDay 只到日、不带时间', /9\/17/.test(formatDay(t)) && !/15/.test(formatDay(t)), formatDay(t));
}

/* ---------- formatDuration ---------- */
{
  check('formatDuration 不足 1 小时用 MM:SS', formatDuration(65_000) === '01:05', formatDuration(65_000));
  check('formatDuration 超过 1 小时用 H:MM:SS', formatDuration(3_725_000) === '1:02:05', formatDuration(3_725_000));
  check('formatDuration 负数/坏值不出现负号', formatDuration(-5000) === '00:00' && formatDuration('abc') === '00:00',
    `${formatDuration(-5000)} / ${formatDuration('abc')}`);
  check('formatDuration 恰好 1 小时', formatDuration(3_600_000) === '1:00:00', formatDuration(3_600_000));
}

const fail = results.filter((r) => !r.ok).length;
console.log(`\n${'='.repeat(62)}\n${fail ? '❌' : '✅'} 全部 ${results.length} 项${fail ? `，失败 ${fail}` : '通过'}\n`);
process.exit(fail ? 1 : 0);
