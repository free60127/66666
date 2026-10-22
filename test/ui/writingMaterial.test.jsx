import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import WritingMaterial from '../../src/components/WritingMaterial.jsx';
import { formatWritingMaterialText, splitWritingMaterial } from '../../src/writingMaterial.js';
import { WRITING_EXAM_BANK } from '../../src/writingExamBank.js';

afterEach(cleanup);
describe('reading material layout', () => {
  it('separates both excerpts, article titles and body paragraphs in the reported TEM-8 question', () => {
    const material = WRITING_EXAM_BANK.find((topic) => topic.id === 'tem8-2024').excerpt;
    render(<WritingMaterial text={material} />);
    expect(screen.getByRole('heading', { name: 'Excerpt 1', level: 4 })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Excerpt 2', level: 4 })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'The Convenience of Online Learning', level: 5 })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Problems Concerning Online Education', level: 5 })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Excerpt 2' }).closest('section').querySelectorAll('p').length).toBeGreaterThan(1);
    expect(formatWritingMaterialText(material)).toContain('\n\nExcerpt 2\n\nProblems Concerning Online Education\n\n');
  });

  it('retains the complete contents of all 18 reading tasks in the same order', () => {
    const materials = WRITING_EXAM_BANK.filter((topic) => topic.excerpt);
    expect(materials).toHaveLength(18);
    for (const topic of materials) {
      expect(formatWritingMaterialText(topic.excerpt).replace(/\s/g, ''), topic.id).toBe(topic.excerpt.replace(/\s/g, ''));
      if (topic.exam === 'tem8') expect(splitWritingMaterial(topic.excerpt).filter((part) => part.label).map((part) => part.label)).toEqual(['Excerpt 1', 'Excerpt 2']);
    }
  });

  it('does not mistake the first sentence of the untitled 2022 excerpts for a heading', () => {
    const material = WRITING_EXAM_BANK.find((topic) => topic.id === 'tem8-2022').excerpt;
    const parts = splitWritingMaterial(material);
    expect(parts[0].title).toBe('');
    expect(parts[0].paragraphs[0]).toMatch(/^What have the Romans/);
    expect(parts[1].title).toBe('');
  });

  it('also separates TEM-4 titles followed by short introductory paragraphs', () => {
    const titles = {
      'tem4-2019': 'How much screen time is too much for kids?',
      'tem4-2016': 'Term-time holiday will be banned',
      'tem4-2015': 'Calls for Homework to Be Scrapped',
    };
    for (const [id, title] of Object.entries(titles)) {
      const material = WRITING_EXAM_BANK.find((topic) => topic.id === id).excerpt;
      expect(splitWritingMaterial(material)[0].title).toBe(title);
    }
    expect(splitWritingMaterial(WRITING_EXAM_BANK.find((topic) => topic.id === 'tem4-2023').excerpt)[0].title).toBe('');
  });

  it('joins PDF line wraps, retains paragraph and bullet boundaries and spaces run-together punctuation', () => {
    const parts = splitWritingMaterial('Excerpt 1\nAn Article Title\nFirst sentence,with a line\nwrap.\n\nNext paragraph.\n●First point\ncontinues here\n●Second point.\nExcerpt 2\nSecond title\nAnother sentence.However,this needs spaces.');
    expect(parts[0].paragraphs).toEqual(['First sentence, with a line wrap.', 'Next paragraph.', '●First point continues here', '●Second point.']);
    expect(parts[1].paragraphs).toEqual(['Another sentence. However, this needs spaces.']);
  });
});
