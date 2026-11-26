import { describe, expect, it } from 'vitest';
import { formatNames, interviewerNameProblems, interviewersLabel, interviewersOf } from './interviewers';
import { validateCandidateInput } from './validation';
import { draftFromAnswer, draftNotes } from '../pages/interview/logic';
import { continueProblems } from '../pages/setup/logic';

describe('interviewers (DATA-5, PANEL-1, PANEL-4)', () => {
  it('DATA-5: a session without interviewers reads as its one interviewer', () => {
    expect(interviewersOf({ interviewer: { name: 'Ana' } })).toEqual(['Ana']);
    expect(interviewersOf({ interviewer: { name: 'Ana' }, interviewers: [] })).toEqual(['Ana']);
    expect(interviewersOf({ interviewer: { name: 'Ana' }, interviewers: ['Ana', 'Ben'] })).toEqual(['Ana', 'Ben']);
  });

  it('PANEL-1: names must be non-empty and different, ignoring case and spacing', () => {
    expect(interviewerNameProblems(['Ana', ' ana ', '', 'Ben  Lee', 'ben lee', 'Cy'])).toEqual([
      null,
      'Each interviewer needs a different name.',
      'Enter the interviewer’s name.',
      null,
      'Each interviewer needs a different name.',
      null,
    ]);
    const base = { initials: 'AB', interviewerName: 'Ana', retentionUntil: '2027-01-01' };
    expect(validateCandidateInput({ ...base, otherInterviewers: ['Ben'] }, '2026-11-24')).toEqual({});
    expect(validateCandidateInput({ ...base, otherInterviewers: ['Ben', 'ANA'] }, '2026-11-24').otherInterviewers).toBe(
      'Interviewer 3: Each interviewer needs a different name.',
    );
    expect(continueProblems({ questionCount: 1, budgetError: null, candidateErrors: { otherInterviewers: 'x' } }).map((p) => p.field)).toEqual(['otherInterviewers']);
  });

  it('PANEL-4: names read naturally wherever the interviewer is shown', () => {
    expect(formatNames(['Ana'])).toBe('Ana');
    expect(formatNames(['Ana', 'Ben'])).toBe('Ana and Ben');
    expect(formatNames(['Ana', 'Ben', 'Cy'])).toBe('Ana, Ben and Cy');
    expect(interviewersLabel({ interviewer: { name: 'Ana' }, interviewers: ['Ana', 'Ben'] })).toBe('Ana and Ben');
  });

  it('PANEL-3, AUD-4: an amended note keeps who made it', () => {
    const d = draftFromAnswer({ score: 3, notes: [{ atSec: 5, text: 'x', by: 'Ben' }, { atSec: 6, text: 'y' }] });
    d.notes[0].text = 'x (edited)';
    expect(draftNotes(d)).toEqual([
      { atSec: 5, text: 'x (edited)', by: 'Ben' },
      { atSec: 6, text: 'y' },
    ]);
  });
});
