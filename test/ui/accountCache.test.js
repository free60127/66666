import { beforeEach, describe, expect, it, vi } from 'vitest';
import { switchDataOwner, dataOwner, forgetAccountCache } from '../../src/accountCache.js';

beforeEach(() => { localStorage.clear(); sessionStorage.clear(); });
describe('账号本机缓存隔离', () => {
  it('浏览器禁用站点存储时，访客初始化不会白屏', () => {
    const get = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new DOMException('Blocked', 'SecurityError'); });
    try { expect(() => switchDataOwner('')).not.toThrow(); } finally { get.mockRestore(); }
  });
  it('首次登录接入访客的旧学习数据，包含迁移凭据', () => {
    localStorage.setItem('bt-history', '[{"jobId":"guest-job"}]');
    localStorage.setItem('bt-sync-code', 'a'.repeat(32));
    switchDataOwner('alice');
    expect(dataOwner()).toBe('alice');
    expect(localStorage.getItem('bt-history')).toContain('guest-job');
    expect(localStorage.getItem('bt-sync-code')).toBe('a'.repeat(32));
  });
  it('退出与换账号切换课文、草稿、Key 和班级，重新登录恢复各自缓存', () => {
    switchDataOwner('alice');
    for (const key of ['bt-lesson-libraries', 'bt-drafts', 'bt-studio-settings-key', 'bts-class-memberships', 'bt-result-job1']) localStorage.setItem(key, 'alice-data');
    switchDataOwner('');
    expect(localStorage.getItem('bt-drafts')).toBeNull();
    switchDataOwner('bob');
    expect(localStorage.getItem('bts-class-memberships')).toBeNull();
    localStorage.setItem('bt-drafts', 'bob-draft');
    switchDataOwner('alice');
    expect(localStorage.getItem('bt-drafts')).toBe('alice-data');
    expect(localStorage.getItem('bt-studio-settings-key')).toBe('alice-data');
    switchDataOwner('bob');
    expect(localStorage.getItem('bt-drafts')).toBe('bob-draft');
    expect(localStorage.getItem('bt-studio-settings-key')).toBeNull();
  });
  it('识别升级前的班级所属账号，防止把旧账号缓存接入新人', () => {
    localStorage.setItem('bts-class-member-owner', 'alice');
    localStorage.setItem('bt-favorites', 'alice-favorites');
    switchDataOwner('bob');
    expect(localStorage.getItem('bt-favorites')).toBeNull();
    switchDataOwner('alice');
    expect(localStorage.getItem('bt-favorites')).toBe('alice-favorites');
  });
  it('注销删除当前账号的本机缓存，之后不会恢复', () => {
    switchDataOwner('alice'); localStorage.setItem('bt-history', 'private');
    switchDataOwner('bob'); switchDataOwner('alice');
    forgetAccountCache('alice');
    expect(localStorage.getItem('bt-history')).toBeNull();
    expect(localStorage.getItem('bt-data-cache:alice')).toBeNull();
  });
});
