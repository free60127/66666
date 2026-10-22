import { beforeEach, describe, expect, it, vi } from 'vitest';
import { exportWritingDrafts, importWritingDrafts, listWritingDrafts, loadWritingState, saveWritingDraft, WRITING_STORE_KEY, writingDraftVersions, writingTopicKey } from '../../src/writing.js';
import { forgetAccountCache, switchDataOwner } from '../../src/accountCache.js';

const a = { id: 'topic-a', zh: 'A', question: 'Discuss online learning.' };
const b = { id: 'topic-b', zh: 'B', question: 'Describe public transport.' };
const draft = (topic, essay) => ({ topic, essay, mode: 'direct', workTitle: topic.zh });
beforeEach(() => { localStorage.clear(); sessionStorage.clear(); });

describe('writing draft isolation and migration', () => {
  it('uses class and homework IDs, including when two assignments have identical prompts', () => {
    const topic = { ...a, id: 'assigned', classId: 'class-a', hwId: 'hw-a' };
    expect(writingTopicKey(topic)).not.toBe(writingTopicKey({ ...topic, hwId: 'hw-b' }));
    expect(writingTopicKey(topic)).not.toBe(writingTopicKey({ ...topic, classId: 'class-b' }));
    expect(writingTopicKey(topic)).not.toBe(writingTopicKey({ ...a, id: 'assigned' }));
  });
  it('reads the old current draft and per-topic collection without deleting either', () => {
    const legacy = { ...draft(a, 'Latest A'), savedAt: 2, drafts: { a: { ...draft(a, 'Old A'), savedAt: 1 }, b: draft(b, 'Saved B') } };
    localStorage.setItem(WRITING_STORE_KEY, JSON.stringify(legacy));
    expect(loadWritingState(writingTopicKey(a)).essay).toBe('Latest A');
    expect(loadWritingState(writingTopicKey(b)).essay).toBe('Saved B');
    saveWritingDraft(draft(a, 'New A'), loadWritingState(writingTopicKey(a)), 'tab-a');
    expect(loadWritingState(writingTopicKey(b)).essay).toBe('Saved B');
    expect(JSON.parse(localStorage.getItem(WRITING_STORE_KEY))).toEqual(legacy);
  });
  it('does not let a stale tab saving B overwrite the newer A text', () => {
    const first = saveWritingDraft(draft(a, 'Initial A'), null, 'tab-a');
    saveWritingDraft(draft(a, 'Latest A'), first, 'tab-a');
    saveWritingDraft(draft(a, 'Initial A'), first, 'tab-b'); // unchanged pagehide
    saveWritingDraft(draft(b, 'B content'), null, 'tab-b');
    expect(loadWritingState(writingTopicKey(a)).essay).toBe('Latest A');
    expect(loadWritingState(writingTopicKey(b)).essay).toBe('B content');
  });
  it('preserves concurrent same-topic edits regardless of identical timestamps', () => {
    vi.spyOn(Date, 'now').mockReturnValue(100);
    const base = saveWritingDraft(draft(a, 'Initial'), null, 'origin');
    const left = saveWritingDraft(draft(a, 'A edit'), base, 'tab-a');
    saveWritingDraft(draft(a, 'B edit'), base, 'tab-b');
    saveWritingDraft(draft(a, 'A second edit'), left, 'tab-a');
    expect(writingDraftVersions(writingTopicKey(a)).map((r) => r.essay).sort()).toEqual(['A second edit', 'B edit']);
  });
  it('recognizes a normal continuation and does not mark it as a conflicting copy', () => {
    const first = saveWritingDraft(draft(a, 'First'), null, 'one');
    const next = saveWritingDraft(draft(a, 'Second'), first, 'two');
    saveWritingDraft(draft(a, 'Third'), next, 'three');
    expect(writingDraftVersions(writingTopicKey(a)).map((r) => r.essay)).toEqual(['Third']);
  });
  it('keeps the current tab topic when another tab updates the shared current pointer', () => {
    saveWritingDraft(draft(a, 'Tab A'), null, 'tab-a');
    const tabPointer = sessionStorage.getItem('bt-writing-current');
    saveWritingDraft(draft(b, 'Tab B'), null, 'tab-b');
    sessionStorage.setItem('bt-writing-current', tabPointer);
    expect(loadWritingState().essay).toBe('Tab A');
    sessionStorage.clear();
    expect(loadWritingState().essay).toBe('Tab B');
  });
  it('round-trips title, paragraphs, angle and guide through backup without replacing newer local text', () => {
    const old = { ...draft(a, 'Saved text'), workTitle: 'My title', mode: 'guided', segs: ['Intro', 'Body', '', 'End'], brief: { stance: 'Saved guide' }, angle: 'My angle' };
    const first = saveWritingDraft(old, null, 'tab-a');
    const backup = JSON.parse(JSON.stringify(exportWritingDrafts()));
    saveWritingDraft({ ...old, segs: ['New intro', 'Body', '', 'End'] }, first, 'tab-a');
    expect(importWritingDrafts(backup)).toBe(1);
    const variants = writingDraftVersions(writingTopicKey(a));
    expect(variants.map((r) => r.segs[0]).sort()).toEqual(['Intro', 'New intro']);
    expect(variants.every((r) => r.workTitle === 'My title' && r.brief.stance === 'Saved guide' && r.angle === 'My angle')).toBe(true);
    expect(importWritingDrafts(backup)).toBe(0);
  });
  it('includes drafts in account switching and account deletion', () => {
    switchDataOwner('alice'); saveWritingDraft(draft(a, 'Private Alice'), null, 'alice-tab');
    switchDataOwner('bob'); expect(listWritingDrafts()).toHaveLength(0);
    saveWritingDraft(draft(a, 'Private Bob'), null, 'bob-tab');
    switchDataOwner('alice'); expect(loadWritingState().essay).toBe('Private Alice');
    forgetAccountCache('alice'); expect(listWritingDrafts()).toHaveLength(0);
    switchDataOwner('bob'); expect(loadWritingState().essay).toBe('Private Bob');
  });
  it('ignores broken imports and rejects writes when storage is full', () => {
    expect(importWritingDrafts([null, [], { topic: { question: {} } }])).toBe(0);
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('quota'); });
    expect(() => saveWritingDraft(draft(a, 'Never saved'), null, 'tab-a')).toThrow('quota');
  });
});
