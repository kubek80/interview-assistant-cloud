// LIVE-9, TEAM-6…TEAM-12, SUM-1…SUM-3, SCORE-11, FLOW-28, PANEL-5, LIVE-3: one interview's debrief,
// Summary row and candidate page, worked out from what the server holds (pure; the server runs it for
// each reader, src/domain/panel.test.ts covers it). The maths is the scoring module's, unchanged; the
// outcome, score source and strengths come from src/domain/round.ts (the local app's Summary rules).
//
// The reader matters: while a round hides other people's scores (LIVE-3, FLOW-27) and the interview is
// running, a reader who has not submitted their own record gets other people's judgements with no
// figures and no words, no panel decision, and no figure built from them (othersHidden below is the
// one rule, used by the live screens, scorecards, the debrief, the Summary and every export).
import { computePanel, computeScorecard, median, type Scorecard } from './scoring';
import { agreedScorecard, medianScores } from './decision';
import { outcomeOf, scoreOf, strengthsAndConcerns, type RoundState } from './round';
import { formatNames, nameKey } from './interviewers';
import { toDomainAnswers } from './live';
import type { Answer, PanelDecision, PlanCategory, Question, Recommendation, Score } from './types';
import type {
  AnswerHighlight,
  AnswerJson,
  CandidateDetailJson,
  DecisionJson,
  JudgementView,
  NoteJson,
  PanelPerson,
  SummaryRow,
} from '../shared/api';

export type InterviewState = 'planned' | 'in_progress' | 'paused' | 'completed';

/** One record as the server loads it (live or entered; drafts too, for who is still interviewing). */
export interface RecordInput {
  id: string;
  origin: 'live' | 'entered';
  ownerId: string | null;
  sharedWith: readonly string[];
  names: readonly string[];
  enteredFor: string | null;
  enteredBy: string | null;
  enteredById: string | null;
  enteredAt: string | null;
  state: 'draft' | 'submitted';
  rating: Score | null;
  recommendation: Recommendation | null;
  rationale: string | null;
  submittedAt: string | null;
  answers: readonly AnswerJson[];
  notes: readonly NoteJson[];
}

export interface PanelInput {
  interview: {
    id: string;
    roundId: string;
    roundName: string;
    roundState: 'open' | 'closed';
    hideOthers: boolean;
    state: InterviewState;
    date: string | null;
    time: string | null;
    startedAt: string | null;
    candidate: { id: string; name: string; requisitionId: string | null };
    trackId: string;
    trackName: string;
  };
  set: { id: string; name: string; fingerprint: string; questions: readonly Question[]; categories: readonly PlanCategory[] };
  panel: ReadonlyArray<{ userId: string; name: string; status: 'expected' | 'joined' | 'submitted' | 'did_not_take_part' }>;
  records: readonly RecordInput[];
  decision: DecisionJson | null;
  hasSummary: boolean;
}

const running = (s: InterviewState) => s === 'in_progress' || s === 'paused';

/** The live record that speaks for a person in an interview: their own, or the one whose screen they share (LIVE-5). */
export function liveRecordFor<R extends Pick<RecordInput, 'origin' | 'ownerId' | 'sharedWith'>>(records: readonly R[], userId: string): R | undefined {
  const live = records.filter((r) => r.origin === 'live');
  return live.find((r) => r.ownerId === userId) ?? live.find((r) => r.sharedWith.includes(userId));
}

/**
 * LIVE-3, FLOW-27: whether other people's judgements are hidden from `readerId`. Only when the round
 * hides them and the interview is running (started, not complete): then a reader sees them once their
 * own record, or the one they share, is submitted. Before the start nothing has been scored in the
 * app (a decision or a judgement entered for a planned interview is the group's record, not a live
 * mark), and once the interview is complete everyone sees everything. Organisers watching without a
 * record of their own wait for completion.
 */
export function othersHidden(hideOthers: boolean, state: InterviewState | 'cancelled', records: ReadonlyArray<Pick<RecordInput, 'origin' | 'ownerId' | 'sharedWith' | 'state'>>, readerId: string): boolean {
  if (!hideOthers || (state !== 'in_progress' && state !== 'paused')) return false;
  return liveRecordFor(records, readerId)?.state !== 'submitted';
}

/** TEAM-8: an entered judgement whose person now has their own live record is superseded: the live one wins. */
export function isSuperseded(r: Pick<RecordInput, 'origin' | 'enteredFor'>, records: ReadonlyArray<Pick<RecordInput, 'origin' | 'ownerId' | 'sharedWith'>>): boolean {
  return r.origin === 'entered' && !!r.enteredFor && !!liveRecordFor(records, r.enteredFor);
}

/** TEAM-8: "Entered by Olive on behalf of Cy Third". */
export function enteredLine(j: Pick<JudgementView, 'origin' | 'enteredBy' | 'names'>): string | null {
  return j.origin === 'entered' ? `Entered by ${j.enteredBy ?? 'someone no longer here'} on behalf of ${formatNames(j.names)}` : null;
}

/** The decision in the domain's shape, so the local app's outcome and score rules apply unchanged. */
export function toDomainDecision(d: DecisionJson): PanelDecision {
  return { recommendation: d.recommendation, rationale: d.rationale, participants: d.participants.map((p) => p.name), rating: d.rating, scores: d.scores, recordedBy: d.recordedBy, recordedAt: d.recordedAt };
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * TEAM-6: each panel member: submitted (their record, or the one they shared), interviewing (joined, not
 * submitted), entered (a judgement entered on their behalf), did not take part, or still to come.
 */
export function panelPeople(panel: PanelInput['panel'], records: readonly RecordInput[]): PanelPerson[] {
  return panel.map((p) => {
    const live = liveRecordFor(records, p.userId);
    const onRecordOf = live && live.ownerId !== p.userId ? live.ownerId : null;
    let status: PanelPerson['status'];
    if (live) status = live.state === 'submitted' ? 'submitted' : 'interviewing';
    else if (records.some((r) => r.origin === 'entered' && r.enteredFor === p.userId && r.state === 'submitted')) status = 'entered';
    else status = p.status === 'did_not_take_part' ? 'did-not-take-part' : 'to-come';
    return { id: p.userId, name: p.name, status, onRecordOf };
  });
}

/** SUM-1, TEAM-6: the state of an interview and what is still missing, in plain words. */
export function stateAndMissing(args: { decided: boolean; state: InterviewState; counted: number; toCome: readonly string[]; interviewing: number }): { state: RoundState; missing: string[] } {
  const { decided, toCome, counted } = args;
  const wait = toCome.length ? `Waiting for ${plural(toCome.length, 'judgement')}: ${formatNames([...toCome])}` : null;
  if (decided) return { state: 'decided', missing: wait ? [`${wait} (decided anyway)`] : [] };
  if (running(args.state)) return { state: 'in-progress', missing: ['Interview in progress', ...(wait && counted ? [wait] : [])] };
  if (!counted) return { state: 'not-interviewed', missing: [args.state === 'completed' ? 'No judgements yet' : 'Not interviewed yet'] };
  if (wait) return { state: 'waiting', missing: [wait, 'No panel decision yet'] };
  return { state: 'no-decision', missing: ['No panel decision yet'] };
}

/** SUM-1: how the recommendations relate: "All agree", "Split", or whose they are when there is one. */
export function agreementText(recommendations: ReadonlyArray<{ names: readonly string[]; recommendation: Recommendation | null }>): string {
  const given = recommendations.filter((r) => r.recommendation);
  if (!given.length) return '';
  if (new Set(given.map((g) => g.recommendation)).size > 1) return 'Split';
  return given.length > 1 ? 'All agree' : `From ${formatNames([...given[0].names])}`;
}

interface Built {
  row: SummaryRow;
  /** Visible, counted judgements with their scorecards and answers (for the detail and the median). */
  members: Array<{ view: JudgementView; scorecard: Scorecard; answers: Answer[] }>;
  hidden: boolean;
}

/** Everything one Summary row shows, for one reader (SUM-1, SUM-2, TEAM-6, TEAM-12, LIVE-3). */
export function buildPanel(input: PanelInput, readerId: string): Built {
  const { interview: iv, set, records } = input;
  const plan = { questions: [...set.questions], categories: [...set.categories] };
  const hidden = othersHidden(iv.hideOthers, iv.state, records, readerId);
  const mineLive = liveRecordFor(records, readerId);
  const submitted = records.filter((r) => r.state === 'submitted');
  const members: Built['members'] = [];
  const judgements: JudgementView[] = submitted.map((r) => {
    const mine = r === mineLive || (r.origin === 'entered' && r.enteredById === readerId);
    const isHidden = hidden && !mine;
    const superseded = isSuperseded(r, records);
    const base = {
      recordId: r.id,
      origin: r.origin,
      names: [...r.names],
      enteredBy: r.origin === 'entered' ? r.enteredBy : null,
      enteredAt: r.enteredAt,
      enteredFor: r.enteredFor,
      submittedAt: r.submittedAt,
      mine: r === mineLive,
      superseded,
      hidden: isHidden,
    };
    if (isHidden) return { ...base, rating: null, recommendation: null, rationale: null, figures: null, categories: [], flagged: [] };
    const answers = toDomainAnswers({ answers: [...r.answers], notes: [...r.notes] }, r.id);
    const sc = computeScorecard(plan, answers);
    const view: JudgementView = {
      ...base,
      rating: r.rating,
      recommendation: r.recommendation,
      rationale: r.rationale ?? '',
      figures: { pct: sc.overallPct, band: sc.band, insufficientEvidence: sc.insufficientEvidence, capped: sc.capApplied, coverage: sc.coverage, answered: sc.answeredCount },
      categories: sc.categories.map((c) => ({ id: c.category.id, average: c.average, pct: c.pct })),
      flagged: sc.flagged.map((q) => ({ index: q.index, score: q.score, skipped: q.skipped })),
    };
    if (!superseded) members.push({ view, scorecard: sc, answers });
    return view;
  });
  const decision = hidden ? null : input.decision;
  const domainDecision = decision ? toDomainDecision(decision) : null;
  const outcome = outcomeOf(domainDecision, members.map((m) => m.view.recommendation));
  const { score, categories, categoryMedians } = scoreOf(plan, domainDecision, members.map((m) => ({ names: m.view.names, scorecard: m.scorecard })));
  const { strengths, concerns } = strengthsAndConcerns(categories, categoryMedians);
  const panelCategories = categories
    ? categories.map((c) => ({ id: c.category.id, average: c.average }))
    : categoryMedians
      ? set.categories.filter((c) => set.questions.some((q) => q.categoryId === c.id)).map((c, i) => ({ id: c.id, average: categoryMedians[i]?.average ?? null }))
      : [];
  const people = panelPeople(input.panel, records);
  const counted = submitted.filter((r) => !isSuperseded(r, records)).length;
  const { state, missing } = stateAndMissing({
    decided: !!input.decision,
    state: iv.state,
    counted,
    toCome: people.filter((p) => p.status === 'to-come').map((p) => p.name),
    interviewing: people.filter((p) => p.status === 'interviewing').length,
  });
  const row: SummaryRow = {
    interviewId: iv.id,
    roundId: iv.roundId,
    roundName: iv.roundName,
    roundState: iv.roundState,
    candidate: iv.candidate,
    trackId: iv.trackId,
    trackName: iv.trackName,
    set: { id: set.id, name: set.name, fingerprint: set.fingerprint, questions: set.questions.length },
    date: iv.date ?? (iv.startedAt ? iv.startedAt.slice(0, 10) : null),
    time: iv.date ? iv.time : null,
    interviewState: iv.state,
    panel: people,
    judgements,
    decision,
    decisionHidden: hidden && !!input.decision,
    outcome,
    agreement: outcome.kind === 'recommendations' ? agreementText(members.map((m) => m.view)) : '',
    score,
    panelCategories,
    strengths,
    concerns,
    state,
    missing,
    hiddenCount: judgements.filter((j) => j.hidden).length,
    hasSummary: input.hasSummary,
  };
  return { row, members, hidden };
}

/** SCORE-11, FLOW-28: the panel figures of the visible judgements with question scores. */
export function panelFigures(members: Built['members']) {
  const scored = members.filter((m) => m.scorecard.answeredCount > 0);
  const p = computePanel(scored.map((m) => ({ ref: m.view.recordId, scorecard: m.scorecard })));
  return { members: scored.length, median: p.median, min: p.min, max: p.max, spread: p.spread, spreadFlag: p.spreadFlag };
}

/** TEAM-9: "Start from the panel's median", from the visible judgements' question scores. */
export function startingMedian(input: Pick<PanelInput, 'set'>, members: Built['members']): Record<string, Score> {
  return medianScores({ questions: [...input.set.questions] }, members.filter((m) => m.scorecard.answeredCount > 0).map((m) => m.answers));
}

/** A whole point between the strongest and weakest answers is a difference worth showing. */
export const MEANINGFUL_DIFFERENCE = 1;

/**
 * SUM-3: the strongest and weakest answers relative to this candidate, not against fixed thresholds:
 * the questions scored above the middle of this candidate's own range and those below it (up to `max`
 * each). When every answer scored about the same (less than a whole point between the highest and the
 * lowest), there is nothing to say and both lists are empty ("even").
 */
export function relativeHighlights<H extends { score: number; index: number }>(items: readonly H[], max = 3): { strongest: H[]; weakest: H[]; note: 'even' | 'none' | null } {
  if (!items.length) return { strongest: [], weakest: [], note: 'none' };
  const scores = items.map((h) => h.score);
  const hi = Math.max(...scores);
  const lo = Math.min(...scores);
  if (hi - lo < MEANINGFUL_DIFFERENCE - 1e-9) return { strongest: [], weakest: [], note: 'even' };
  const mid = (hi + lo) / 2;
  return {
    strongest: items.filter((h) => h.score > mid + 1e-9).sort((a, b) => b.score - a.score || a.index - b.index).slice(0, max),
    weakest: items.filter((h) => h.score < mid - 1e-9).sort((a, b) => a.score - b.score || a.index - b.index).slice(0, max),
    note: null,
  };
}

/** SUM-3: the candidate page: categories per person and the panel, highlights with everyone's notes, flags and skips. */
export function candidateDetail(input: PanelInput, built: Built, max = 3): CandidateDetailJson {
  const { set } = input;
  const plan = { questions: [...set.questions], categories: [...set.categories] };
  const decision = built.row.decision;
  const agreed = agreedScorecard(plan, decision ? { scores: decision.scores } : null);
  const scored = built.members.filter((m) => m.scorecard.answeredCount > 0);
  const columns: CandidateDetailJson['columns'] = [
    ...(agreed ? [{ label: 'Agreed', source: 'agreed' as const, recordId: null }] : []),
    ...scored.map((m) => ({ label: formatNames(m.view.names), source: 'judgement' as const, recordId: m.view.recordId })),
  ];
  const categories = set.categories
    .filter((c) => set.questions.some((q) => q.categoryId === c.id))
    .map((c) => {
      const of = (sc: Scorecard | null) => sc?.categories.find((x) => x.category.id === c.id);
      const cols = [...(agreed ? [agreed] : []), ...scored.map((m) => m.scorecard)];
      const memberAvgs = scored.map((m) => of(m.scorecard)?.average).filter((a): a is number => a != null);
      return {
        id: c.id,
        name: c.name,
        mustHave: c.mustHave,
        averages: cols.map((sc) => of(sc)?.average ?? null),
        pcts: cols.map((sc) => of(sc)?.pct ?? null),
        figure: agreed ? (of(agreed)?.average ?? null) : median(memberAvgs),
      };
    });
  const catNames = new Map(set.categories.map((c) => [c.id, c.name]));
  const members = built.members;
  const highlights: AnswerHighlight[] = set.questions.flatMap((q, index) => {
    const by = members.map((m) => {
      const a = m.answers.find((x) => x.questionId === q.id);
      return { names: m.view.names, score: (a && !a.skipped && a.score != null ? a.score : null) as Score | null, notes: (a?.notes ?? []).map((n) => n.text.trim()).filter(Boolean) };
    });
    const given = by.map((b) => b.score).filter((s): s is Score => s != null);
    const score = decision?.scores[q.id] ?? median(given);
    if (score == null) return [];
    return [{ index, questionId: q.id, text: q.text, category: catNames.get(q.categoryId) ?? '', score, by: by.filter((b) => b.score != null || b.notes.length) }];
  });
  const { strongest, weakest, note } = relativeHighlights(highlights, max);
  const flagged = set.questions.flatMap((q, index) => {
    const by = members.filter((m) => m.answers.some((a) => a.questionId === q.id && a.flagged)).map((m) => formatNames(m.view.names));
    return by.length ? [{ index, text: q.text, by }] : [];
  });
  const skipped = set.questions.flatMap((q, index) =>
    members.flatMap((m) => {
      const a = m.answers.find((x) => x.questionId === q.id && x.skipped);
      return a ? [{ index, text: q.text, by: formatNames(m.view.names), reason: a.skipReason ?? '' }] : [];
    }),
  );
  return { columns, categories, strongest, weakest, highlightsNote: note, flagged, skipped };
}

/** TEAM-7: the names that already have a judgement in this interview (to refuse a second one for the same person). */
export function takenNames(records: readonly Pick<RecordInput, 'names' | 'state'>[]): Set<string> {
  return new Set(records.flatMap((r) => r.names.map(nameKey)));
}
