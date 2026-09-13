/**
 * 错误类型分布的「跨次/本次」切换回归测试。
 *
 * 起因（用户实测反馈）：默认显示「看最近几次」，但点了「只算本次」之后**再也切不回去**，
 * 只能刷新页面重进。
 *
 * 根因：切换按钮的显示条件写成了 `multi = 当前统计的 used > 1` ——
 * 而「只算本次」时 used 恰好等于 1，于是 `multi` 变 false、**整行按钮自己消失**。
 * 这类"开关把自己关掉"的 bug 在浏览器里点一下就能复现，但以前没有组件测试基建，只能靠用户发现。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import React from 'react';
import { ErrorProfile } from '../../src/components/ResultSheet/cards.jsx';

const mkResult = (title, cat, level = 'error') => ({
  title,
  sentences: [{ cn: '句子', draft: 'd', ai: 'a', original: 'o', findings: [{ category: cat, level, from: 'x', to: 'y', explanation: 'e' }] }],
});

/** 组件通过 loadResultCache(jobId) 从 localStorage 读历史结果，所以要先种进去 */
const seed = (jobId, result) => localStorage.setItem('bt-result-' + jobId, JSON.stringify(result));

beforeEach(() => {
  localStorage.clear();
  cleanup();
});

describe('ErrorProfile 跨次 / 本次切换', () => {
  it('只有一次作业时不显示切换按钮', () => {
    const only = mkResult('本次', '词义');
    render(<ErrorProfile result={only} history={[]} />);
    expect(screen.queryByText('只算本次')).toBeNull();
    expect(screen.queryByText('看最近几次')).toBeNull();
  });

  it('有多次作业时显示两个切换按钮', () => {
    const cur = mkResult('本次', '词义');
    seed('job-a', mkResult('上次', '语法'));
    render(<ErrorProfile result={cur} history={[{ jobId: 'job-a' }]} />);
    expect(screen.getByText('只算本次')).toBeTruthy();
    expect(screen.getByText('看最近几次')).toBeTruthy();
  });

  it('★ 点「只算本次」后按钮仍在，且能切回「看最近几次」（本次修复的 bug）', () => {
    const cur = mkResult('本次', '词义');
    seed('job-a', mkResult('上次', '语法'));
    render(<ErrorProfile result={cur} history={[{ jobId: 'job-a' }]} />);

    fireEvent.click(screen.getByText('只算本次'));
    // 关键断言：按钮不能因为"本次只剩 1 条"就消失
    expect(screen.getByText('只算本次')).toBeTruthy();
    expect(screen.getByText('看最近几次')).toBeTruthy();
    expect(screen.getByText(/本次作业/)).toBeTruthy();

    fireEvent.click(screen.getByText('看最近几次'));
    expect(screen.getByText(/最近 2 次作业/)).toBeTruthy();
  });

  it('反复切换不会卡住', () => {
    const cur = mkResult('本次', '词义');
    seed('job-a', mkResult('上次', '语法'));
    render(<ErrorProfile result={cur} history={[{ jobId: 'job-a' }]} />);
    for (let i = 0; i < 3; i += 1) {
      fireEvent.click(screen.getByText('只算本次'));
      expect(screen.getByText(/本次作业/)).toBeTruthy();
      fireEvent.click(screen.getByText('看最近几次'));
      expect(screen.getByText(/最近 2 次作业/)).toBeTruthy();
    }
  });

  it('「只算本次」只统计当前这条（不含历史里的类别）', () => {
    const cur = mkResult('本次', '词义');
    seed('job-a', mkResult('上次', '语法'));
    const { container } = render(<ErrorProfile result={cur} history={[{ jobId: 'job-a' }]} />);
    fireEvent.click(screen.getByText('只算本次'));
    // 只查柱状图里的类别标签（"词义"在结论文案里也会出现，用 getByText 会命中多处）
    const labels = [...container.querySelectorAll('.errbar-label')].map((e) => e.textContent);
    expect(labels).toEqual(['词义']);
    expect(labels).not.toContain('语法');
  });

  it('★ 同一次作业不会重复计入（当前结果 + 它在历史里的缓存副本）', () => {
    const cur = mkResult('本次', '词义');
    const job = 'job-cur';
    seed(job, cur); // 历史里也有这一条（真实场景：练完就入历史了）
    const { container } = render(<ErrorProfile result={cur} history={[{ jobId: job }]} jobId={job} />);
    // 只练过一遍：不该出现切换按钮，也不该显示"最近 2 次"
    expect(screen.queryByText('只算本次')).toBeNull();
    expect(container.querySelector('.muted.small').textContent).toMatch(/最近 1 次作业/);
    // 柱状图只统计一次（1 处），不是被算了两次
    expect(container.querySelector('.errbar-num').textContent).toBe('1');
  });

  it('历史缓存损坏时不影响渲染（按"没有上次"处理）', () => {
    const cur = mkResult('本次', '词义');
    localStorage.setItem('bt-result-bad', '{不是 JSON');
    const { container } = render(<ErrorProfile result={cur} history={[{ jobId: 'bad' }]} />);
    const labels = [...container.querySelectorAll('.errbar-label')].map((e) => e.textContent);
    expect(labels).toEqual(['词义']);
    expect(screen.queryByText('只算本次')).toBeNull(); // 只有一条可用 → 不给切换
  });
});
