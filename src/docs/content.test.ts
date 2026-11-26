import { describe, expect, it } from 'vitest';
import { DOC_PAGES, REQ_INDEX, docHref, docSection, reqHelpLabel, searchDocs, slugify } from './content';

describe('in-app docs', () => {
  it('OV-3: all docs/*.md pages are bundled, in filename order with Verification last, titled by their first heading', () => {
    expect(DOC_PAGES.map((p) => p.slug)).toEqual([
      '01-overview',
      '02-interview-flow',
      '03-rubric',
      '04-scoring',
      '05-question-bank',
      '06-data-privacy',
      '07-keyboard-accessibility',
      '08-data-model',
      '09-roadmap',
      '11-interviewers-transcripts-ai',
      '12-planning-and-panels',
      '13-hosted-version',
      '10-verification',
    ]);
    expect(DOC_PAGES.find((p) => p.slug === '13-hosted-version')!.title).toBe('Hosted version');
    expect(DOC_PAGES.find((p) => p.slug === '12-planning-and-panels')!.title).toBe('Planning ahead and working as a panel');
    expect(DOC_PAGES.find((p) => p.slug === '11-interviewers-transcripts-ai')!.title).toBe('Interviewers, transcripts and AI second opinion');
    expect(DOC_PAGES[3].title).toBe('Scoring');
  });

  it('OV-3: every requirement id is indexed to the page that defines it', () => {
    expect(REQ_INDEX.get('SCORE-3')).toBe('04-scoring');
    expect(REQ_INDEX.get('FLOW-31')).toBe('02-interview-flow');
    expect(REQ_INDEX.get('RES-3')).toBe('02-interview-flow');
    expect(REQ_INDEX.get('AUD-4')).toBe('06-data-privacy');
    expect(REQ_INDEX.get('A11Y-7')).toBe('07-keyboard-accessibility');
    expect(REQ_INDEX.get('PANEL-3')).toBe('11-interviewers-transcripts-ai');
    expect(REQ_INDEX.get('DATA-5')).toBe('08-data-model');
    expect(REQ_INDEX.get('TEAM-6')).toBe('12-planning-and-panels');
    expect(REQ_INDEX.get('AUTH-2')).toBe('13-hosted-version');
    expect(REQ_INDEX.get('SUM-1')).toBe('12-planning-and-panels');
    const prefixes = new Set([...REQ_INDEX.keys()].map((k) => k.split('-')[0]));
    for (const p of ['FLOW', 'SCORE', 'RUB', 'BANK', 'PRIV', 'AUD', 'SEC', 'KEY', 'A11Y', 'DATA', 'RES', 'OV']) expect(prefixes).toContain(p);
  });

  it('UX-7: help links are named after the docs section, never the requirement id', () => {
    expect(reqHelpLabel('PRIV-4')).toBe('Consent');
    expect(reqHelpLabel('FLOW-9')).toBe('Configure the plan');
    expect(reqHelpLabel('UX-7')).toBe('Ease of use');
    expect(reqHelpLabel('NOPE-1')).toBe('documentation');
    for (const id of REQ_INDEX.keys()) expect(reqHelpLabel(id)).not.toMatch(/[A-Z]+-\d+/);
  });

  it('OV-3: deep links point at the defining page with the requirement highlighted', () => {
    expect(docHref({ req: 'SCORE-3' })).toBe('/docs/04-scoring?req=SCORE-3');
    expect(docHref({ slug: '03-rubric', section: slugify('Suggested score') })).toBe('/docs/03-rubric?section=suggested-score');
  });

  it('OV-3: search finds text across all pages and links to the requirement', () => {
    const hits = searchDocs('insufficient evidence');
    expect(hits.some((h) => h.slug === '04-scoring' && h.req === 'SCORE-6')).toBe(true);
    expect(searchDocs('x')).toEqual([]);
  });

  it('AI-2: the privacy notice section of page 11 can be shown on its own (Admin shows it before the AI can be turned on)', () => {
    const notice = docSection('11-interviewers-transcripts-ai', 'Privacy notice for AI and transcripts')!;
    expect(notice).toMatch(/^## Privacy notice for AI and transcripts\n/);
    expect(notice).toContain('The transcript leaves the organisation\'s database when the AI second opinion is run');
    expect(notice).toContain('APP 1.7-1.9');
    expect(notice).not.toContain('## AI second opinion');
    expect(docSection('11-interviewers-transcripts-ai', 'No such heading')).toBeNull();
  });
});
