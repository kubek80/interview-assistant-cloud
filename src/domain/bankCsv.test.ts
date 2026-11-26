import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseDelimited, detectDelimiter } from './csv';
import { CSV_COLUMNS, bulkTemplateCsv, headerColumns, joinListCell, parseBulkQuestions, splitListCell, trackQuestionsCsv } from './bankCsv';
import { trackFileRows } from './validation';
import type { TrackFile } from './types';
import { makeCategory, makeQuestion } from '../test/fixtures';

const cats = [makeCategory({ id: 'tt-alpha', name: 'Alpha' }), makeCategory({ id: 'tt-beta', name: 'Beta & co' })];

describe('CSV parser', () => {
  it('BANK-13: handles quotes, doubled quotes, embedded delimiters and line breaks, CRLF and a BOM', () => {
    const text = '﻿a,"b, with comma","c ""quoted""","multi\r\nline"\r\n1,2,3,4\n\n"x"  ,y,,"last"';
    expect(parseDelimited(text)).toEqual([
      ['a', 'b, with comma', 'c "quoted"', 'multi\r\nline'],
      ['1', '2', '3', '4'],
      ['x  ', 'y', '', 'last'],
    ]);
    expect(parseDelimited('a\tb\t"c\td"\n', '\t')).toEqual([['a', 'b', 'c\td']]);
    expect(parseDelimited('no final newline')).toEqual([['no final newline']]);
    expect(parseDelimited('')).toEqual([]);
    expect(detectDelimiter('a\tb\nc')).toBe('\t');
    expect(detectDelimiter('a,b\tc\n')).toBe('\t');
    expect(detectDelimiter('a,b')).toBe(',');
  });

  it('BANK-13: list cells split on line breaks, or on semicolons when there are none; joining round-trips', () => {
    expect(splitListCell('a; b ;;c')).toEqual(['a', 'b', 'c']);
    expect(splitListCell('a; still a\nb')).toEqual(['a; still a', 'b']);
    for (const items of [['one'], ['x; y'], ['a', 'b; c', 'd']]) expect(splitListCell(joinListCell(items))).toEqual(items);
  });
});

describe('bulk add (BANK-13)', () => {
  it('BANK-13: tab-separated rows pasted from a spreadsheet, without a header, become drafts in column order', () => {
    const row = ['What is X?', 'We ask about X', 'Alpha', 'advanced', 'knowledge', 'one; two', 'bad', 'why?', ''].join('\t');
    const r = parseBulkQuestions(row, 'tt', cats);
    expect(r.header).toBe(false);
    expect(r.problem).toBeNull();
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0].problems).toEqual([]);
    expect(r.rows[0].draft).toMatchObject({ text: 'What is X?', description: 'We ask about X', categoryId: 'tt-alpha', difficulty: 'advanced', type: 'knowledge', lookFor: ['one', 'two'], redFlags: ['bad'], probes: ['why?'], timeMin: 4 });
  });

  it('BANK-13: a header row is optional and matched by name, in any order; letters and short names work', () => {
    const csv = 'Type,Question,Category,Difficulty,Description,L,R,P,Minutes,Owner\nS,Do Y,beta & co,E,Steer Y,a,b,c,9,Sam\n';
    const r = parseBulkQuestions(csv, 'tt', cats);
    expect(r.header).toBe(true);
    expect(r.ignoredColumns).toEqual(['Owner']);
    expect(r.rows[0].problems).toEqual([]);
    expect(r.rows[0].line).toBe(2);
    expect(r.rows[0].draft).toMatchObject({ type: 'scenario', difficulty: 'expert', categoryId: 'tt-beta', timeMin: 9 });
    expect(headerColumns(['Question', 'Description'])).toEqual(['text', 'description']);
    expect(headerColumns(['What is X?', 'We ask'])).toBeNull();
  });

  it('BANK-13: every problem is reported on its row; an unknown category is offered to be created', () => {
    const csv = [
      'Question,Description,Category,Difficulty,Type,Key points,Red flags,Probes,Time (min)',
      'Good one,Steer,Alpha,core,knowledge,a,b,c,',
      ',No text,Alpha,core,knowledge,a,b,c,',
      'Bad type,Steer,Alpha,core,quiz,a,b,c,',
      'No lists,Steer,Alpha,core,design,,,,',
      'New cat,Steer,Gamma,core,knowledge,a,b,c,x',
      'Good one,Steer,Alpha,core,knowledge,a,b,c,',
    ].join('\n');
    const r = parseBulkQuestions(csv, 'tt', cats);
    const p = r.rows.map((x) => x.problems.join(' | '));
    expect(p[0]).toBe('');
    expect(p[1]).toMatch(/question text/);
    expect(p[2]).toMatch(/Unknown type “quiz”/);
    expect(p[3]).toMatch(/key point/);
    expect(p[3]).toMatch(/red flag/);
    expect(p[3]).toMatch(/probe/);
    expect(p[4]).toMatch(/Time “x”/);
    expect(r.rows[4].newCategory).toBe('Gamma');
    expect(r.rows[4].draft.categoryId).toBe('tt-gamma');
    expect(r.newCategories).toEqual(['Gamma']);
    expect(p[5]).toMatch(/Same question text as row 2/);
    expect(parseBulkQuestions('Good one,Steer,Alpha,core,knowledge,a,b,c,', 'tt', cats, ['good one']).rows[0].problems).toEqual(['This question is already in the track.']);
  });

  it('RUB-5 BANK-13: behavioural rows default to core and keep their own key points and red flags (no shared items are added)', () => {
    const r = parseBulkQuestions('Tell me about a time,Steer,Alpha,,behavioural,Owned it,Vague,What next?,', 'tt', cats);
    expect(r.rows[0].problems).toEqual([]);
    expect(r.rows[0].draft.difficulty).toBe('core');
    expect(r.rows[0].draft.timeMin).toBe(4);
    expect(r.rows[0].draft.lookFor).toEqual(['Owned it']);
    expect(r.rows[0].draft.redFlags).toEqual(['Vague']);
  });

  it('BANK-13: reports input with nothing to import', () => {
    expect(parseBulkQuestions('  ', 'tt', cats).problem).toMatch(/Paste/);
    expect(parseBulkQuestions('Question,Description,Category\n', 'tt', cats).problem).toMatch(/no question rows/);
  });

  it('BANK-13: a track exported as CSV imports back to the same questions (round trip), including awkward text', () => {
    const qs = [
      makeQuestion({ id: 'tt-1', categoryId: 'tt-alpha', text: 'Plain, with "quotes"', description: '=SUM(A1) looks like a formula', difficulty: 'expert', type: 'design', timeMin: 11, lookFor: ['a; b in one item', '-leading dash', 'line'], redFlags: ['@mention'], probes: ['one; probe only'] }),
      makeQuestion({ id: 'tt-2', categoryId: 'tt-beta', text: 'Behavioural one', type: 'behavioural', difficulty: 'core', timeMin: 4, lookFor: ['Specific situation: one real occasion; when and with whom.', 'Own actions: says "I", not "we".', 'Own'], redFlags: ['Answers hypothetically, e.g. "I would…"', 'Blames others'], probes: ['p'] }),
      makeQuestion({ id: 'tt-3', categoryId: 'tt-alpha', status: 'retired' }),
    ];
    const csv = trackQuestionsCsv(qs, cats);
    expect(csv.split('\r\n')[0]).toBe('Question,Description,Category,Difficulty,Type,Key points,Red flags,Probes,Time (min)');
    expect(csv).toContain("'=SUM(A1)"); // neutralised for spreadsheets (SEC-2)
    const back = parseBulkQuestions(csv, 'tt', cats);
    expect(back.rows.map((r) => r.problems)).toEqual([[], []]);
    const fields = ({ text, description, categoryId, difficulty, type, timeMin, lookFor, redFlags, probes }: (typeof qs)[number]) => ({ text, description, categoryId, difficulty, type, timeMin, lookFor, redFlags, probes });
    expect(back.rows.map((r) => fields({ ...qs[0], ...r.draft }))).toEqual([fields(qs[0]), fields(qs[1])]);
  });

  it('BANK-13 BANK-15: every bundled track exported as CSV imports back to exactly the same sentence-length key points and red flags (items with ";", quotes and colons)', () => {
    for (const id of ['web', 'qa', 'edge', 'aks']) {
      const file = JSON.parse(readFileSync(fileURLToPath(new URL(`../../seed/${id}.json`, import.meta.url)), 'utf8')) as TrackFile;
      const { questions, categories } = trackFileRows(file);
      const back = parseBulkQuestions(trackQuestionsCsv(questions, categories), id, categories);
      expect(back.rows.flatMap((r) => r.problems), id).toEqual([]);
      const active = questions.filter((q) => q.status === 'active').sort((a, b) => a.number - b.number);
      expect(back.rows.map((r) => [r.draft.text, r.draft.lookFor, r.draft.redFlags, r.draft.probes])).toEqual(active.map((q) => [q.text, q.lookFor, q.redFlags, q.probes]));
    }
  });

  it('BANK-13 BANK-15: the template parses with a header and no problems in its example rows (apart from a new category); its items are full sentences', () => {
    const r = parseBulkQuestions(bulkTemplateCsv(), 'tt', [...cats, makeCategory({ id: 'tt-b', name: 'Behavioural & leadership' })]);
    expect(r.header).toBe(true);
    expect(r.rows).toHaveLength(2);
    expect(r.rows.flatMap((x) => x.problems)).toEqual([]);
    for (const item of r.rows.flatMap((x) => [...x.draft.lookFor, ...x.draft.redFlags])) expect(item.split(' ').length).toBeGreaterThanOrEqual(8);
    expect(r.newCategories).toEqual(['CI/CD']);
    expect(CSV_COLUMNS).toHaveLength(9);
  });
});
