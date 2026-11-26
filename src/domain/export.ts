// Export formats (FLOW-31, AUD-3, DATA-4, BANK-7). Pure: callers record the export in the audit log.
import { DIFFICULTY_LABEL, TYPE_LABEL, scoreLabel } from './rubric';
import { BAND_LABELS, formatAverage, formatCoverage, formatPct, type Scorecard } from './scoring';
import { candidateKey, shortFingerprint } from './plan';
import type {
  Answer,
  AuditEvent,
  Category,
  InterviewPlan,
  InvitationFile,
  PanelFile,
  PanelFileEntry,
  PlanFile,
  PlannedInterview,
  Question,
  Session,
  SessionFile,
  Track,
  TrackFile,
} from './types';
import { FORMAT_VERSION, RECOMMENDATION_LABELS } from './types';
import type { NoteEntry } from './types';
import { formatNames, interviewersOf } from './interviewers';
import { enteredLabel } from './decision';
import { STATE_LABELS, scoreText, type CandidateDetail, type RoundRow } from './round';
import { AI_LABEL, AI_NOT_A_DECISION, formatDifference, isNotCandidateQuote, type AiReport } from './ai/report';
import type { AiQuotation } from './ai/types';

const FORMULA_START = /^[=+\-@\t\r]/;

/** RFC 4180 cell; strings that a spreadsheet would treat as a formula are prefixed with an apostrophe. */
export function csvCell(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '';
  if (typeof value === 'boolean') return value ? 'yes' : 'no';
  let s = typeof value === 'string' ? value : JSON.stringify(value);
  if (FORMULA_START.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) || s !== s.trim() ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(rows: readonly (readonly unknown[])[]): string {
  return rows.map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

function formatElapsed(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

/** FLOW-15, PANEL-3: "[1:35] (Ben) text"; the author only when the note carries one. */
function noteLine(n: NoteEntry, text: string): string {
  return `[${formatElapsed(n.atSec)}]${n.by ? ` (${n.by})` : ''} ${text}`;
}

/** AI-6: a quotation as plain text with where it was found. */
function quoteText(q: AiQuotation): string {
  const where = q.status === 'verified' ? `line ${q.line ?? '?'}${q.speaker ? `, ${q.speaker}` : ''}, verified${isNotCandidateQuote(q) ? ', not the candidate’s words' : ''}` : 'unverified: not found in the transcript';
  return `"${q.text}" (${where})`;
}

/** AI-11: CSV columns for the AI second opinion, all prefixed with its label. */
const AI_CSV_HEADER = [
  `${AI_LABEL}: score`,
  `${AI_LABEL}: covered in transcript`,
  `${AI_LABEL}: difference from interviewers`,
  `${AI_LABEL}: worth discussing`,
  `${AI_LABEL}: key points judged covered`,
  `${AI_LABEL}: red flags judged present`,
  `${AI_LABEL}: rationale`,
  `${AI_LABEL}: quotations`,
  `${AI_LABEL}: model (${AI_NOT_A_DECISION})`,
];

/** FLOW-31: one row per question. AI-11: with `ai`, extra columns labelled "AI second opinion: …" (never merged into the human columns). */
export function scorecardCsv(scorecard: Scorecard, ai?: AiReport | null): string {
  const header = [
    'Order', 'Question id', 'Number', 'Version', 'Category', 'Must-have', 'Difficulty', 'Type', 'Weight',
    'Score', 'Value', 'Skipped', 'Skip reason', 'Flagged', 'Key points covered', 'Red flags seen',
    'Probe handled', 'Time spent (s)', 'Notes', 'Question',
  ];
  const rows = scorecard.questions.map((r) => [
    r.index + 1,
    r.question.id,
    r.question.number,
    r.question.version,
    r.category?.name ?? r.question.categoryId,
    !!r.category?.mustHave,
    DIFFICULTY_LABEL[r.question.difficulty],
    TYPE_LABEL[r.question.type],
    round(r.weight, 4),
    r.score,
    r.value == null ? null : round(r.value, 4),
    r.skipped,
    r.skipReason,
    r.flagged,
    `${r.answer?.coveredKeyPoints.length ?? 0}/${r.question.lookFor.length}`,
    // BANK-15: red flags are sentences that may contain ";", so each goes on its own line in the cell.
    (r.answer?.redFlagsSeen ?? []).map((i) => r.question.redFlags[i]).filter(Boolean).join('\n'),
    !!r.answer?.probeHandled,
    r.answer?.elapsedSec ?? 0,
    (r.answer?.notes ?? []).map((n) => noteLine(n, n.text)).join('\n'),
    r.question.text,
    ...(ai ? aiCsvCells(ai, r.index) : []),
  ]);
  return toCsv([ai ? [...header, ...AI_CSV_HEADER] : header, ...rows]);
}

function aiCsvCells(ai: AiReport, index: number): unknown[] {
  const row = ai.comparison.rows[index];
  const q = row?.ai;
  if (!row || !q) return AI_CSV_HEADER.map(() => null);
  return [
    row.aiScore,
    q.covered,
    formatDifference(row.difference),
    row.worthDiscussing,
    `${q.coveredKeyPoints.length}/${row.question.lookFor.length}`,
    q.redFlagsSeen.map((i) => row.question.redFlags[i]).filter(Boolean).join('\n'),
    q.rationale,
    q.quotes.map(quoteText).join('\n'),
    `${ai.result.model}${ai.outOfDate ? ' (out of date: the transcript changed since the run)' : ''}`,
  ];
}

/** Escapes text for use inside Markdown, including table cells. */
export function mdEscape(s: string): string {
  return s.replace(/([\\`*_{}[\]()#+!|<>~])/g, '\\$1').replace(/\r?\n/g, ' ');
}

/** FLOW-31: Markdown scorecard. AI-11: with `ai`, a separate section labelled "AI second opinion … not a decision". */
export function scorecardMarkdown(plan: InterviewPlan, session: Session, scorecard: Scorecard, ai?: AiReport | null): string {
  const c = session.candidate;
  const lines: string[] = [];
  const bandText = scorecard.insufficientEvidence
    ? 'Insufficient evidence'
    : scorecard.band
      ? BAND_LABELS[scorecard.band] + (scorecard.capApplied ? ` (capped by must-have: ${scorecard.capCategories.map((x) => x.name).join(', ')})` : '')
      : '–';
  const [initials, req] = candidateKey(c).split('|');
  lines.push(`# Scorecard: ${mdEscape(initials)}${req ? ` (${mdEscape(req)})` : ''}`, '');
  lines.push(`- Plan: ${mdEscape(plan.name)} (fingerprint ${shortFingerprint(plan.fingerprint)})`);
  const names = interviewersOf(session);
  // PANEL-4: a shared record names everyone who ran the interview.
  lines.push(names.length > 1 ? `- Interviewers: ${mdEscape(formatNames(names))} (one shared scorecard)` : `- Interviewer: ${mdEscape(names[0])}`);
  // TEAM-8: a judgement entered by hand says so wherever it is exported.
  if (session.origin === 'entered') lines.push(`- ${mdEscape(enteredLabel(session) ?? '')} on ${session.enteredAt ?? session.submittedAt}`);
  lines.push(`- State: ${session.state}${session.submittedAt ? `, submitted ${session.submittedAt}` : ''}`);
  lines.push(`- Overall: **${formatPct(scorecard.overallPct)}** (coverage ${formatCoverage(scorecard.coverage)})`);
  lines.push(`- Advisory band: ${bandText}`);
  const whose = names.length > 1 ? "Interviewers'" : "Interviewer's";
  lines.push(`- ${whose} overall rating: ${session.overall.rating ?? '–'}`);
  lines.push(`- ${whose} recommendation: ${session.overall.recommendation ? RECOMMENDATION_LABELS[session.overall.recommendation] : '–'}`);
  lines.push('', '## Rationale', '', session.overall.rationale.trim() ? mdEscape(session.overall.rationale) : '_None given._', '');

  lines.push('## Categories', '', '| Category | Must-have | Answered | Percentage | Average |', '|---|---|---|---|---|');
  for (const cat of scorecard.categories) {
    lines.push(`| ${mdEscape(cat.category.name)} | ${cat.category.mustHave ? 'yes' : 'no'} | ${cat.answeredCount}/${cat.plannedCount} | ${formatPct(cat.pct)} | ${formatAverage(cat.average)} |`);
  }
  lines.push('');
  lines.push(`**Strengths:** ${scorecard.strengths.map((s) => mdEscape(s.category.name)).join(', ') || 'none'}`, '');
  lines.push(
    `**Concerns:** ${scorecard.concerns.map((s) => mdEscape(s.category.name) + (s.reason === 'no-evidence' ? ' (no evidence)' : '')).join(', ') || 'none'}`,
    '',
  );

  lines.push('## Questions', '', '| # | Question | Category | Difficulty | Score | Notes |', '|---|---|---|---|---|---|');
  for (const r of scorecard.questions) {
    const scoreText = r.skipped ? 'Skipped' : r.score ? `${r.score} ${scoreLabel(r.score)}` : '–';
    const notes = (r.answer?.notes ?? []).map((n) => noteLine({ ...n, by: n.by && mdEscape(n.by) }, mdEscape(n.text))).join('<br>');
    lines.push(`| ${r.index + 1}${r.flagged ? ' (flagged)' : ''} | ${mdEscape(r.question.text)} | ${mdEscape(r.category?.name ?? '')} | ${DIFFICULTY_LABEL[r.question.difficulty]} | ${scoreText} | ${notes} |`);
  }
  if (scorecard.skipped.length) {
    lines.push('', '## Skipped', '');
    for (const r of scorecard.skipped) lines.push(`- Q${r.index + 1}: ${mdEscape(r.question.text)} (reason: ${mdEscape(r.skipReason ?? '')})`);
  }
  if (scorecard.flagged.length) {
    lines.push('', '## Flagged for debrief', '');
    for (const r of scorecard.flagged) lines.push(`- Q${r.index + 1}: ${mdEscape(r.question.text)}`);
  }
  lines.push('', '_The band is advisory. People record every score and the final decision._', '');
  if (ai) lines.push(...aiMarkdown(ai, scorecard));
  return lines.join('\n');
}

/** AI-7, AI-8, AI-11: the AI second opinion as its own Markdown section, after the human scorecard. */
export function aiMarkdown(ai: AiReport, human?: Pick<Scorecard, 'questions'>): string[] {
  const { result, aiScorecard: sc, comparison } = ai;
  const band = sc.insufficientEvidence ? 'Insufficient evidence' : sc.band ? BAND_LABELS[sc.band] + (sc.capApplied ? ' (capped by must-have)' : '') : '–';
  const lines: string[] = ['', `## ${AI_LABEL} (${mdEscape(result.model)}), ${AI_NOT_A_DECISION}`, ''];
  lines.push(`_Advisory. Scored by ${mdEscape(result.model)} from the transcript, with the same questions and rubric. It never changes a human score, the panel score, the advisory band or the recorded recommendation, and is not counted in the panel median or spread._`, '');
  lines.push(`- Run: ${result.createdAt}; transcript fingerprint ${result.transcriptHash.slice(0, 12)}`);
  if (ai.outOfDate) lines.push('- **Out of date:** the transcript has changed since this was run.');
  lines.push(`- ${AI_LABEL} overall: ${formatPct(sc.overallPct)} (coverage ${formatCoverage(sc.coverage)}; questions not covered in the transcript count as skipped)`);
  lines.push(`- ${AI_LABEL} advisory band: ${band}`);
  if (result.unverifiedQuoteCount) lines.push(`- Unverified quotations (not found in the transcript): ${result.unverifiedQuoteCount}`);
  lines.push('', `| # | Question | Interviewers' score | ${AI_LABEL} score | Difference |`, '|---|---|---|---|---|');
  for (const r of comparison.rows) {
    const humanText = r.humanScore ?? (human?.questions[r.index]?.skipped ? 'Skipped' : '–');
    const aiScore = r.aiCovered ? String(r.aiScore) : 'Not covered';
    lines.push(`| ${r.index + 1}${r.worthDiscussing ? ' (worth discussing)' : ''} | ${mdEscape(r.question.text)} | ${humanText} | ${aiScore} | ${formatDifference(r.difference) ?? '–'} |`);
  }
  lines.push('', `### Worth discussing (differences of 2 points or more)`, '');
  if (!comparison.worthDiscussing.length) lines.push('None.');
  for (const r of comparison.worthDiscussing) {
    lines.push(`- Q${r.index + 1}: interviewers ${r.humanScore}, ${AI_LABEL} ${r.aiScore}. ${mdEscape(r.ai?.rationale ?? '')}`);
    for (const q of r.ai?.quotes ?? []) lines.push(`  - ${mdEscape(quoteText(q))}`);
  }
  lines.push('', '### Rationale and evidence per question', '');
  for (const r of comparison.rows) {
    const q = r.ai;
    if (!q) continue;
    lines.push(`- Q${r.index + 1}: ${q.covered ? `score ${q.score}` : 'not covered in the transcript'}. ${mdEscape(q.rationale)}`);
    // BANK-15: key points and red flags are sentences, one list item each.
    if (q.coveredKeyPoints.length) lines.push('  - Key points judged covered:', ...q.coveredKeyPoints.map((i) => `    - ${mdEscape(r.question.lookFor[i] ?? '')}`));
    if (q.redFlagsSeen.length) lines.push('  - Red flags judged present:', ...q.redFlagsSeen.map((i) => `    - ${mdEscape(r.question.redFlags[i] ?? '')}`));
    for (const quote of q.quotes) lines.push(`  - ${mdEscape(quoteText(quote))}`);
  }
  lines.push('');
  return lines;
}


/** AUD-3 */
export function auditCsv(events: readonly AuditEvent[]): string {
  const rows = events.map((e) => [
    e.id ?? '',
    e.ts,
    e.actor,
    e.action,
    e.entity,
    e.entityId,
    e.before === undefined || e.before === null ? '' : JSON.stringify(e.before),
    e.after === undefined || e.after === null ? '' : JSON.stringify(e.after),
    e.reason,
  ]);
  return toCsv([['Id', 'Time', 'Actor', 'Action', 'Entity', 'Entity id', 'Before', 'After', 'Reason'], ...rows]);
}

/** DATA-4 */
export function planFile(plan: InterviewPlan, now = new Date()): PlanFile {
  return { kind: 'interview-plan', formatVersion: FORMAT_VERSION, exportedAt: now.toISOString(), plan };
}

/** DATA-4: embeds the plan so it can be imported on a device that has never seen it. */
export function sessionFile(plan: InterviewPlan, session: Session, answers: readonly Answer[], now = new Date()): SessionFile {
  return { kind: 'interview-session', formatVersion: FORMAT_VERSION, exportedAt: now.toISOString(), plan, session, answers: [...answers] };
}

/**
 * TEAM-3: an invitation file for one or more planned interviews. It carries the questions (plan
 * snapshot and fingerprint), the candidate's name or initials and requisition id only (TEAM-14), the
 * schedule, the expected interviewers, the recording option, the note and the organiser. No
 * scores and nothing about this device's own record.
 */
export function invitationFile(items: ReadonlyArray<{ planned: PlannedInterview; plan: InterviewPlan }>, now = new Date()): InvitationFile {
  return {
    kind: 'interview-invitation',
    formatVersion: FORMAT_VERSION,
    exportedAt: now.toISOString(),
    interviews: items.map(({ planned: p, plan }) => ({
      invitationId: p.id,
      createdAt: p.createdAt,
      updatedAt: p.updatedAt,
      organiser: p.organiser,
      candidate: { initials: p.candidate.initials, requisitionId: p.candidate.requisitionId },
      date: p.date,
      time: p.time,
      expectedInterviewers: [...p.expected],
      recordingNotice: p.recordingNotice,
      note: p.note,
      retentionUntil: p.retentionUntil,
      plan,
    })),
  };
}

/**
 * BANK-4, BANK-7: current bank in seed-file shape. Keys are written in the same order as the seed
 * files and categories in `categoryOrder` (the seed's order), so an exported file diffs cleanly
 * against the one in seed/.
 */
export function trackFile(track: Track, categories: readonly Category[], questions: readonly Question[], categoryOrder: readonly string[] = []): TrackFile {
  const rank = (id: string) => {
    const i = categoryOrder.indexOf(id);
    return i < 0 ? Number.MAX_SAFE_INTEGER : i;
  };
  return {
    track: { id: track.id, name: track.name, version: track.version },
    categories: [...categories]
      .sort((a, b) => rank(a.id) - rank(b.id) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      .map((c) => ({ id: c.id, name: c.name, weight: c.weight, mustHave: c.mustHave })),
    questions: [...questions]
      .sort((a, b) => a.number - b.number)
      .map((q) => ({
        id: q.id,
        number: q.number,
        categoryId: q.categoryId,
        text: q.text,
        description: q.description ?? '',
        difficulty: q.difficulty,
        type: q.type,
        timeMin: q.timeMin,
        lookFor: [...q.lookFor],
        redFlags: [...q.redFlags],
        probes: [...q.probes],
        version: q.version,
        status: q.status,
        rubricOverride: q.rubricOverride ?? null,
      })),
  };
}

export function toJson(value: unknown): string {
  return JSON.stringify(value, null, 2) + '\n';
}

/** File names avoid candidate data; ids are random (PRIV-3). */
export function exportFileName(kind: 'plan' | 'session' | 'scorecard' | 'audit' | 'track' | 'candidate-data' | 'invitation' | 'panel' | 'round-report', id: string, ext: string, now = new Date()): string {
  const day = now.toISOString().slice(0, 10);
  return `interview-${kind}-${id.slice(0, 8)}-${day}.${ext}`;
}

function round(n: number, dp: number): number {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}

/** TEAM-13: a panel file for one or more panels. */
export function panelFile(entries: readonly PanelFileEntry[], exportedBy: string, now = new Date()): PanelFile {
  return { kind: 'interview-panel', formatVersion: FORMAT_VERSION, exportedAt: now.toISOString(), exportedBy, panels: [...entries] };
}

// ---------------------------------------------------------------------------------------------
// SUM-5: the round report

export interface RoundReportItem {
  row: RoundRow;
  detail: CandidateDetail;
  /** AI-11: an AI second opinion held for the panel, if any (model and overall). */
  ai?: Array<{ model: string; text: string }>;
}

const dateText = (row: RoundRow) => (row.date ? `${row.date}${row.time ? ` ${row.time}` : ''}` : '–');

/** TEAM-12, SUM-1: the outcome as text, saying whether it is the panel decision or the recommendations. */
export function outcomeLine(row: RoundRow): string {
  if (row.outcome.kind === 'decision') return `Panel decision: ${row.outcome.text}${row.outcome.tally.length ? ` (recommendations: ${row.outcome.tally.map((t) => `${RECOMMENDATION_LABELS[t.recommendation]} ×${t.count}`).join(', ')})` : ''}`;
  if (row.outcome.kind === 'none') return 'No recommendation yet';
  return `Recommendations: ${row.outcome.text}${row.outcome.split ? ' (split)' : ''}`;
}

/** SUM-5: overview table then each candidate's page and written summary, as Markdown. */
export function roundMarkdown(items: readonly RoundReportItem[], meta: { exportedBy: string; scope: string; now?: Date }): string {
  const now = meta.now ?? new Date();
  const lines: string[] = ['# Interview round summary', ''];
  lines.push(`Exported ${now.toISOString().slice(0, 10)} by ${mdEscape(meta.exportedBy)}. ${items.length} candidate${items.length === 1 ? '' : 's'}${meta.scope ? ` (${mdEscape(meta.scope)})` : ''}.`, '');
  lines.push('_Scores and bands are advisory. People make every decision. A panel decision is shown next to, never instead of, the individual figures._', '');
  const sets = new Set(items.map((i) => i.row.fingerprint));
  if (sets.size > 1) lines.push(`**Note:** these candidates were asked ${sets.size} different question sets. Scores are directly comparable only within the same question set.`, '');
  lines.push('## Overview', '', '| Candidate | Date | Role | Question set | Interviewers | Outcome | Score | Strengths | Concerns | Still missing |', '|---|---|---|---|---|---|---|---|---|---|');
  for (const { row } of items) {
    lines.push(
      `| ${mdEscape(row.candidate)} | ${dateText(row)} | ${mdEscape(row.trackName)} | ${mdEscape(row.planName)} | ${mdEscape(formatNames(row.interviewers)) || '–'} | ${mdEscape(outcomeLine(row))} | ${mdEscape(scoreText(row.score))} | ${mdEscape(row.strengths.join(', ')) || '–'} | ${mdEscape(row.concerns.join(', ')) || '–'} | ${mdEscape(row.missing.join('; ')) || 'Nothing'} |`,
    );
  }
  for (const { row, detail, ai } of items) {
    lines.push('', `## ${mdEscape(row.candidate)}`, '');
    lines.push(`- Role: ${mdEscape(row.trackName)}; question set: ${mdEscape(row.planName)} (${row.questionCount} questions)`);
    lines.push(`- Date: ${dateText(row)}; interviewers: ${mdEscape(formatNames(row.interviewers)) || '–'}`);
    lines.push(`- State: ${STATE_LABELS[row.state]}${row.missing.length ? `; still missing: ${mdEscape(row.missing.join('; '))}` : ''}`);
    lines.push(`- Outcome: ${mdEscape(outcomeLine(row))}`);
    lines.push(`- Score: ${mdEscape(scoreText(row.score))}`);
    if (row.decision) {
      const d = row.decision;
      lines.push('', '### Panel decision', '');
      lines.push(`**${RECOMMENDATION_LABELS[d.recommendation]}**${d.rating ? `, agreed overall rating ${d.rating}` : ''}. Agreed by ${mdEscape(formatNames(d.participants))}; recorded by ${mdEscape(d.recordedBy)} on ${d.recordedAt.slice(0, 10)}${d.changedAt ? `, last changed by ${mdEscape(d.changedBy ?? '')} on ${d.changedAt.slice(0, 10)}` : ''}.`, '');
      lines.push(mdEscape(d.rationale));
    }
    lines.push('', '### Written summary', '', row.summaryText.trim() ? mdEscape(row.summaryText) : '_None written yet._');
    lines.push('', '### Judgements', '');
    if (!row.judgements.length) lines.push('_No judgements yet._');
    else {
      lines.push('| Interviewer | Recommendation | Overall rating | Overall | Advisory band | Rationale |', '|---|---|---|---|---|---|');
      for (const j of row.judgements) {
        const who = mdEscape(formatNames(j.names)) + (j.entered ? ` (${mdEscape(enteredLabel(j.session) ?? '')}, ${j.session.enteredAt?.slice(0, 10) ?? ''})` : '');
        if (j.hidden) {
          lines.push(`| ${who} | Submitted (hidden until your own is submitted) | | | | |`);
          continue;
        }
        const sc = j.scorecard;
        const band = !sc || sc.answeredCount === 0 ? 'no question scores' : sc.insufficientEvidence ? 'Insufficient evidence' : sc.band ? BAND_LABELS[sc.band] : '–';
        lines.push(`| ${who} | ${j.recommendation ? RECOMMENDATION_LABELS[j.recommendation] : '–'} | ${j.session.overall.rating ?? '–'} | ${sc && sc.answeredCount ? formatPct(sc.overallPct) : '–'} | ${band} | ${mdEscape(j.session.overall.rationale)} |`);
      }
    }
    if (detail.columns.length && detail.categories.length) {
      lines.push('', '### Categories (average score 1–4)', '', `| Category | ${detail.columns.map((c) => mdEscape(c.label)).join(' | ')} | Panel |`, `|---|${detail.columns.map(() => '---|').join('')}---|`);
      for (const c of detail.categories) lines.push(`| ${mdEscape(c.name)}${c.mustHave ? ' (must-have)' : ''} | ${c.averages.map((a) => formatAverage(a)).join(' | ')} | ${formatAverage(c.figure)} |`);
    }
    const highlight = (title: string, list: CandidateDetail['strongest']) => {
      lines.push('', `### ${title}`, '');
      if (!list.length) lines.push('None.');
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
    for (const a of ai ?? []) lines.push('', `### ${AI_LABEL} (${mdEscape(a.model)}), ${AI_NOT_A_DECISION}`, '', mdEscape(a.text));
  }
  lines.push('');
  return lines.join('\n');
}

/** SUM-5: the overview table as CSV, one row per candidate. */
export function roundCsv(rows: readonly RoundRow[]): string {
  const header = [
    'Candidate', 'Requisition', 'Role', 'Question set', 'Date', 'Interviewers', 'State', 'Still missing',
    'Outcome from', 'Outcome', 'Recommendations', 'Panel decision rationale', 'Score (%)', 'Score from', 'Advisory band',
    'Spread (points)', 'Strengths', 'Concerns', 'Judgements entered by hand', 'Written summary',
  ];
  return toCsv([
    header,
    ...rows.map((r) => [
      r.name,
      r.requisition,
      r.trackName,
      r.planName,
      dateText(r) === '–' ? '' : dateText(r),
      formatNames(r.interviewers),
      STATE_LABELS[r.state],
      r.missing.join('; '),
      r.outcome.kind === 'decision' ? 'Panel decision' : r.outcome.kind === 'recommendations' ? 'Recommendations' : '',
      r.outcome.kind === 'none' ? '' : r.outcome.text,
      r.outcome.tally.map((t) => `${RECOMMENDATION_LABELS[t.recommendation]} x${t.count}`).join(', '),
      r.decision?.rationale ?? '',
      r.score.pct == null ? null : Math.round(r.score.pct),
      r.score.pct == null ? '' : r.score.label,
      r.score.insufficientEvidence ? 'Insufficient evidence' : r.score.band ? BAND_LABELS[r.score.band] + (r.score.capped ? ' (capped)' : '') : '',
      r.score.spread == null ? null : Math.round(r.score.spread),
      r.strengths.join(', '),
      r.concerns.join(', '),
      r.judgements.filter((j) => j.entered).map((j) => enteredLabel(j.session)).join('; '),
      r.summaryText,
    ]),
  ]);
}
