// SUM-5, TEAM-8, TEAM-12: the round report as Markdown and the overview as CSV, from the rows the
// server worked out for the reader (hidden judgements stay hidden). Pure; panelExport.test.ts.
import { BAND_LABELS, formatAverage, formatPct } from './scoring';
import { formatNames } from './interviewers';
import { STATE_LABELS, scoreText } from './round';
import { csvCell, mdEscape, toCsv } from './export';
import { enteredLine } from './panel';
import { RECOMMENDATION_LABELS } from './types';
import type { CandidateDetailJson, JudgementView, SummaryRow, WrittenSummaryJson } from '../shared/api';

export { csvCell };

const dateText = (row: Pick<SummaryRow, 'date' | 'time'>) => (row.date ? `${row.date}${row.time ? ` ${row.time}` : ''}` : '–');
export const candidateText = (row: Pick<SummaryRow, 'candidate'>) => `${row.candidate.name}${row.candidate.requisitionId ? ` · ${row.candidate.requisitionId}` : ''}`;

/** TEAM-12, SUM-1: the outcome in words, saying whether it is the panel decision or the recommendations. */
export function outcomeText(row: Pick<SummaryRow, 'outcome' | 'decisionHidden' | 'agreement'>): string {
  const o = row.outcome;
  if (o.kind === 'decision') return `Panel decision: ${o.text}${o.tally.length ? ` (recommendations: ${o.tally.map((t) => `${RECOMMENDATION_LABELS[t.recommendation]} ×${t.count}`).join(', ')})` : ''}`;
  if (o.kind === 'none') return row.decisionHidden ? 'Hidden until your own judgement is submitted' : 'No recommendation yet';
  return `Recommendations: ${o.text}${row.agreement ? ` (${row.agreement.toLowerCase().startsWith('from') ? row.agreement : row.agreement.toLowerCase()})` : ''}`;
}

/** Who is on the panel and where they are (TEAM-6): "Ana Diaz (submitted), Ben Ng (to come)". */
export function panelText(row: Pick<SummaryRow, 'panel'>): string {
  const words = { submitted: 'submitted', entered: 'entered on their behalf', interviewing: 'interviewing', 'to-come': 'to come', 'did-not-take-part': 'did not take part' } as const;
  return row.panel.map((p) => `${p.name} (${words[p.status]})`).join(', ');
}

function judgementWho(j: JudgementView): string {
  const who = formatNames(j.names);
  const entered = enteredLine(j);
  return `${who}${entered ? ` (${entered}${j.enteredAt ? `, ${j.enteredAt.slice(0, 10)}` : ''})` : ''}${j.superseded ? ' (replaced by their own record)' : ''}`;
}

function bandWords(j: JudgementView): string {
  const f = j.figures;
  if (!f || f.answered === 0) return 'no question scores';
  return f.insufficientEvidence ? 'Insufficient evidence' : f.band ? BAND_LABELS[f.band] + (f.capped ? ' (capped)' : '') : '–';
}

export interface ReportItem {
  row: SummaryRow;
  detail: CandidateDetailJson;
  summary: WrittenSummaryJson | null;
}

/** SUM-5: overview table, then each candidate's page with the written summary, as Markdown. */
export function summaryMarkdown(items: readonly ReportItem[], meta: { preparedBy: string; scope: string; now?: Date }): string {
  const now = meta.now ?? new Date();
  const lines: string[] = ['# Interview round summary', ''];
  lines.push(`Prepared ${now.toISOString().slice(0, 10)} by ${mdEscape(meta.preparedBy)}. ${items.length} candidate${items.length === 1 ? '' : 's'}${meta.scope ? ` (${mdEscape(meta.scope)})` : ''}.`, '');
  lines.push('_Scores and bands are advisory. People make every decision. A panel decision is shown next to, never instead of, the individual figures._', '');
  const sets = new Set(items.map((i) => i.row.set.fingerprint));
  if (sets.size > 1) lines.push(`**Note:** these candidates were asked ${sets.size} different question sets. Scores are directly comparable only within the same question set.`, '');
  lines.push('## Overview', '', '| Candidate | Date | Question set | Panel | Outcome | Score | Strengths | Concerns | Still missing |', '|---|---|---|---|---|---|---|---|---|');
  for (const { row } of items) {
    lines.push(
      `| ${mdEscape(candidateText(row))} | ${dateText(row)} | ${mdEscape(row.set.name)} | ${mdEscape(panelText(row)) || '–'} | ${mdEscape(outcomeText(row))} | ${mdEscape(scoreText(row.score))} | ${mdEscape(row.strengths.join(', ')) || '–'} | ${mdEscape(row.concerns.join(', ')) || '–'} | ${mdEscape(row.missing.join('; ')) || 'Nothing'} |`,
    );
  }
  for (const { row, detail, summary } of items) {
    lines.push('', `## ${mdEscape(candidateText(row))}`, '');
    lines.push(`- Round: ${mdEscape(row.roundName)}; role: ${mdEscape(row.trackName)}; question set: ${mdEscape(row.set.name)} (${row.set.questions} questions)`);
    lines.push(`- Date: ${dateText(row)}; panel: ${mdEscape(panelText(row)) || '–'}`);
    lines.push(`- State: ${STATE_LABELS[row.state]}${row.missing.length ? `; still missing: ${mdEscape(row.missing.join('; '))}` : ''}`);
    lines.push(`- Outcome: ${mdEscape(outcomeText(row))}`);
    lines.push(`- Score: ${mdEscape(scoreText(row.score))}`);
    if (row.decision) {
      const d = row.decision;
      lines.push('', '### Panel decision', '');
      lines.push(
        `**${RECOMMENDATION_LABELS[d.recommendation]}**${d.rating ? `, agreed overall rating ${d.rating}` : ''}${Object.keys(d.scores).length ? `, agreed scores for ${Object.keys(d.scores).length} questions` : ''}. Agreed by ${mdEscape(formatNames(d.participants.map((p) => p.name)))}; recorded by ${mdEscape(d.recordedBy)} on ${d.recordedAt.slice(0, 10)}${d.changedAt ? `, last changed by ${mdEscape(d.changedBy ?? '')} on ${d.changedAt.slice(0, 10)}` : ''}.`,
        '',
      );
      lines.push(mdEscape(d.rationale));
    }
    lines.push('', '### Written summary', '', summary?.text.trim() ? mdEscape(summary.text) : '_None written yet._');
    if (summary?.text.trim()) lines.push('', `_Last edited by ${mdEscape(summary.updatedBy)} on ${summary.updatedAt.slice(0, 10)}._`);
    lines.push('', '### Judgements', '');
    if (!row.judgements.length) lines.push('_No judgements yet._');
    else {
      lines.push('| Interviewer | Recommendation | Overall rating | Overall | Advisory band | Rationale |', '|---|---|---|---|---|---|');
      for (const j of row.judgements) {
        if (j.hidden) {
          lines.push(`| ${mdEscape(judgementWho(j))} | Submitted (hidden until your own is submitted) | | | | |`);
          continue;
        }
        const f = j.figures;
        lines.push(`| ${mdEscape(judgementWho(j))} | ${j.recommendation ? RECOMMENDATION_LABELS[j.recommendation] : '–'} | ${j.rating ?? '–'} | ${f && f.answered ? formatPct(f.pct) : '–'} | ${bandWords(j)} | ${mdEscape(j.rationale ?? '')} |`);
      }
    }
    if (detail.columns.length && detail.categories.length) {
      lines.push('', '### Categories (average score 1–4)', '', `| Category | ${detail.columns.map((c) => mdEscape(c.label)).join(' | ')} | Panel |`, `|---|${detail.columns.map(() => '---|').join('')}---|`);
      for (const c of detail.categories) lines.push(`| ${mdEscape(c.name)}${c.mustHave ? ' (must-have)' : ''} | ${c.averages.map((a) => formatAverage(a)).join(' | ')} | ${formatAverage(c.figure)} |`);
    }
    const highlight = (title: string, list: CandidateDetailJson['strongest']) => {
      lines.push('', `### ${title}`, '');
      if (!list.length) lines.push(detail.highlightsNote === 'even' ? 'Every answer was scored about the same.' : 'None.');
      for (const h of list) {
        lines.push(`- Q${h.index + 1} (${mdEscape(h.category)}), score ${formatAverage(h.score)}: ${mdEscape(h.text)}`);
        for (const b of h.by) lines.push(`  - ${mdEscape(formatNames(b.names))}: ${b.score ?? '–'}${b.notes.length ? `. ${b.notes.map(mdEscape).join(' / ')}` : ''}`);
      }
    };
    highlight('Strongest answers', detail.strongest);
    highlight('Weakest answers', detail.weakest);
    if (detail.flagged.length) {
      lines.push('', '### Flagged questions', '');
      for (const f of detail.flagged) lines.push(`- Q${f.index + 1}: ${mdEscape(f.text)} (flagged by ${mdEscape(formatNames(f.by))})`);
    }
    if (detail.skipped.length) {
      lines.push('', '### Skipped questions', '');
      for (const k of detail.skipped) lines.push(`- Q${k.index + 1}: ${mdEscape(k.text)} (${mdEscape(k.by)}: ${mdEscape(k.reason)})`);
    }
  }
  lines.push('');
  return lines.join('\n');
}

/** SUM-5: the overview as CSV, one row per candidate (per interview). */
export function summaryCsv(items: ReadonlyArray<{ row: SummaryRow; summary: WrittenSummaryJson | null }>): string {
  const header = [
    'Candidate', 'Requisition', 'Round', 'Role', 'Question set', 'Comparison code', 'Date', 'Panel', 'State', 'Still missing',
    'Outcome from', 'Outcome', 'Agreement', 'Panel decision rationale', 'Score (%)', 'Score from', 'Advisory band',
    'Spread (points)', 'Strengths', 'Concerns', 'Judgements entered on someone’s behalf', 'Written summary',
  ];
  return toCsv([
    header,
    ...items.map(({ row: r, summary }) => [
      r.candidate.name,
      r.candidate.requisitionId ?? '',
      r.roundName,
      r.trackName,
      r.set.name,
      r.set.fingerprint.slice(0, 8),
      dateText(r) === '–' ? '' : dateText(r),
      panelText(r),
      STATE_LABELS[r.state],
      r.missing.join('; '),
      r.outcome.kind === 'decision' ? 'Panel decision' : r.outcome.kind === 'recommendations' ? 'Recommendations' : '',
      r.outcome.kind === 'none' ? '' : r.outcome.text,
      r.agreement,
      r.decision?.rationale ?? '',
      r.score.pct == null ? null : Math.round(r.score.pct),
      r.score.pct == null ? '' : r.score.label,
      r.score.insufficientEvidence ? 'Insufficient evidence' : r.score.band ? BAND_LABELS[r.score.band] + (r.score.capped ? ' (capped)' : '') : '',
      r.score.spread == null ? null : Math.round(r.score.spread),
      r.strengths.join(', '),
      r.concerns.join(', '),
      r.judgements.filter((j) => j.origin === 'entered').map((j) => enteredLine(j)).join('; '),
      summary?.text ?? '',
    ]),
  ]);
}
