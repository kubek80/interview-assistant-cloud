import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { RepoError, exportRoundReport, useInterviewerName, useRound, useTracks } from '../db';
import { candidateDetail, roundRow, STATE_LABELS, type RoundRow, type RoundState } from '../domain/round';
import { dayLabel, localDay } from '../domain/team';
import { formatNames, nameKey } from '../domain/interviewers';
import { shortFingerprint } from '../domain/plan';
import { RECOMMENDATION_LABELS } from '../domain/types';
import {
  BandBadge,
  Button,
  EmptyState,
  Field,
  Icon,
  MenuButton,
  PageHeader,
  Select,
  TextInput,
  buttonClass,
  downloadFile,
  formatPct,
  useDocumentTitle,
  useToast,
} from '../ui';
import {
  FIRST_DIR,
  NO_FILTER,
  OUTCOME_OPTIONS,
  filterRows,
  filterWords,
  groupBySet,
  isFiltered,
  sortRows,
  stateCounts,
  type OutcomeFilter,
  type SortDir,
  type SortKey,
  type SummaryFilter,
} from './summary/model';
import { RecommendationBadge, PanelFileDialog } from './panel/PanelParts';
import { RoundPrint } from './summary/RoundPrint';
import { useImportFiles } from './team/ImportFiles';
import '../styles/pages/summary.css';
import '../styles/pages/panel.css';

const STORE = 'summary-view';
interface ViewState {
  filter: SummaryFilter;
  sort: SortKey;
  dir: SortDir;
}
const DEFAULT_VIEW: ViewState = { filter: NO_FILTER, sort: 'date', dir: 'desc' };

/** The filters and sort survive a visit to a candidate page (this tab only; never in the URL: PRIV-3). */
function useViewState(): [ViewState, (v: ViewState) => void] {
  const [v, setV] = useState<ViewState>(() => {
    try {
      const raw = sessionStorage.getItem(STORE);
      return raw ? { ...DEFAULT_VIEW, ...JSON.parse(raw), filter: { ...NO_FILTER, ...JSON.parse(raw).filter } } : DEFAULT_VIEW;
    } catch {
      return DEFAULT_VIEW;
    }
  });
  const set = (next: ViewState) => {
    setV(next);
    try {
      sessionStorage.setItem(STORE, JSON.stringify(next));
    } catch {
      /* storage unavailable: the view simply is not remembered */
    }
  };
  return [v, set];
}

const STATE_ORDER: RoundState[] = ['waiting', 'no-decision', 'in-progress', 'not-interviewed', 'decided'];
const STATE_ICON: Record<RoundState, 'check' | 'clock' | 'play' | 'circle' | 'alert'> = { decided: 'check', waiting: 'clock', 'no-decision': 'alert', 'in-progress': 'play', 'not-interviewed': 'circle' };

/**
 * Route: /summary (SUM-1, SUM-2, SUM-5, SUM-6, TEAM-12). One row per candidate (per question set):
 * who, when, the outcome (the panel decision, else the recommendations, agreement or split said
 * plainly), the score with where it comes from and the advisory band, strengths and concerns, and
 * what is still missing. Sort by any column; filter; search. Candidates asked different questions
 * are grouped by question set. The export menu gives the round report and panel files.
 */
export default function Summary() {
  useDocumentTitle('Summary');
  const round = useRound();
  const tracks = useTracks();
  const me = useInterviewerName();
  const importer = useImportFiles();
  const { toast } = useToast();
  const [view, setView] = useViewState();
  const [panelFiles, setPanelFiles] = useState(false);
  const [printing, setPrinting] = useState<null | Array<{ row: RoundRow; detail: ReturnType<typeof candidateDetail> }>>(null);
  const today = localDay(new Date());
  const trackNames = useMemo(() => new Map((tracks ?? []).map((t) => [t.id, t.name])), [tracks]);
  const all = useMemo(() => (round ?? []).map((p) => ({ row: roundRow(p), data: p })), [round]);
  const rows = useMemo(() => all.map((x) => x.row), [all]);
  const shown = useMemo(() => sortRows(filterRows(rows, view.filter), view.sort, view.dir), [rows, view]);
  const groups = useMemo(() => groupBySet(shown), [shown]);
  const counts = useMemo(() => stateCounts(rows), [rows]);
  const reqs = useMemo(() => [...new Set(rows.map((r) => r.requisition).filter(Boolean))].sort(), [rows]);
  const roles = useMemo(() => [...new Set(rows.map((r) => r.trackId))], [rows]);
  const sets = new Set(shown.map((r) => r.fingerprint)).size;
  const hidden = shown.reduce((n, r) => n + r.hidden, 0);
  const f = view.filter;
  const setFilter = (patch: Partial<SummaryFilter>) => setView({ ...view, filter: { ...f, ...patch } });
  const scope = filterWords(f, trackNames);
  const refs = shown.map((r) => r.ref);

  useEffect(() => {
    if (!printing) return;
    // The print layout stays mounted (hidden on screen) so "Save as PDF" can be repeated from the browser menu.
    const t = requestAnimationFrame(() => window.print());
    return () => cancelAnimationFrame(t);
  }, [printing]);

  const report = async (format: 'markdown' | 'csv' | 'print') => {
    try {
      const file = await exportRoundReport(refs, format, scope);
      if (format === 'print') {
        const byRef = new Map(all.map((x) => [x.row.ref, x.data]));
        setPrinting(shown.map((row) => ({ row, detail: candidateDetail(byRef.get(row.ref)!) })));
        return;
      }
      downloadFile(file!.fileName, file!.mime, file!.text);
      toast(`Round report saved as ${format === 'markdown' ? 'Markdown' : 'CSV'} (${shown.length} candidate${shown.length === 1 ? '' : 's'}). The export is recorded in the audit log.`, 'success');
    } catch (err) {
      toast(err instanceof RepoError ? err.message : 'The report could not be exported.', 'error');
    }
  };

  const sortBy = (key: SortKey) => setView({ ...view, sort: key, dir: view.sort === key ? (view.dir === 'asc' ? 'desc' : 'asc') : FIRST_DIR[key] });

  let body: ReactNode;
  if (round === undefined) {
    body = (
      <p className="muted" aria-busy="true">
        Loading…
      </p>
    );
  } else if (!rows.length) {
    body = (
      <EmptyState
        title="Nothing to summarise yet."
        actions={
          <>
            <Link to="/plan" className={buttonClass('default')}>
              Plan several interviews
            </Link>
            <Link to="/new">New interview</Link>
          </>
        }
      >
        <p>Interviews appear here as soon as they are planned, and fill in as judgements and decisions come in. A panel file from someone else can be imported too.</p>
      </EmptyState>
    );
  } else {
    body = (
      <>
        <p className="sum-counts" data-testid="sum-counts">
          <span>
            <strong className="tabular">{rows.length}</strong> candidate{rows.length === 1 ? '' : 's'}
          </span>
          {STATE_ORDER.filter((s) => counts[s]).map((s) => (
            <button
              key={s}
              type="button"
              className="sum-chip"
              aria-pressed={f.state === s}
              onClick={() => setFilter({ state: f.state === s ? '' : s })}
            >
              <Icon name={STATE_ICON[s]} />
              <strong className="tabular">{counts[s]}</strong> {STATE_LABELS[s].toLowerCase()}
            </button>
          ))}
        </p>
        <div className="sum-filters" role="search" aria-label="Find candidates">
          <Field label="Find a candidate" className="sum-filters__search">
            <TextInput type="search" value={f.text} onChange={(e) => setFilter({ text: e.target.value })} placeholder="Name, initials or requisition" autoComplete="off" />
          </Field>
          {(roles.length > 1 || f.trackId) && (
            <Field label="Role">
              <Select value={f.trackId} onChange={(e) => setFilter({ trackId: e.target.value })} options={[{ value: '', label: 'All roles' }, ...roles.map((id) => ({ value: id, label: trackNames.get(id) ?? id }))]} />
            </Field>
          )}
          {reqs.length > 0 && (
            <Field label="Requisition">
              <Select value={f.requisition} onChange={(e) => setFilter({ requisition: e.target.value })} options={[{ value: '', label: 'All' }, ...reqs.map((r) => ({ value: r, label: r }))]} />
            </Field>
          )}
          <Field label="Outcome">
            <Select value={f.outcome} onChange={(e) => setFilter({ outcome: e.target.value as OutcomeFilter })} options={OUTCOME_OPTIONS.map((o) => ({ value: o.value, label: o.label }))} />
          </Field>
          <Field label="From">
            <TextInput type="date" value={f.from} onChange={(e) => setFilter({ from: e.target.value })} />
          </Field>
          <Field label="To">
            <TextInput type="date" value={f.to} onChange={(e) => setFilter({ to: e.target.value })} />
          </Field>
          {isFiltered(f) && (
            <Button size="sm" variant="ghost" icon="x" className="sum-filters__clear" onClick={() => setView({ ...view, filter: NO_FILTER })}>
              Clear
            </Button>
          )}
        </div>
        {hidden > 0 && (
          <p className="small muted">
            <Icon name="eye-off" /> {hidden} judgement{hidden === 1 ? ' is' : 's are'} hidden until your own interview of that candidate is submitted (independent scoring).
          </p>
        )}
        {sets > 1 && (
          <p className="sum-sets" role="note">
            <Icon name="info" /> These candidates were asked {sets} different question sets. Scores are directly comparable only within a group.
          </p>
        )}
        {shown.length === 0 ? (
          <p className="dash-empty">
            <Icon name="info" /> No candidate matches.
          </p>
        ) : (
          groups.map((g) => (
            <section key={g.fingerprint} className="sum-group" aria-label={sets > 1 ? `${g.trackName}, ${g.planName}` : 'Candidates'}>
              {(sets > 1 || g.rows.length > 1) && (
                <div className="sum-group__head">
                  {sets > 1 ? (
                    <h2 className="sum-group__title">
                      {g.planName} <span className="muted small">· {g.planName.startsWith(g.trackName) ? '' : `${g.trackName} · `}{g.questionCount} questions · comparison code {shortFingerprint(g.fingerprint)} · {g.rows.length} candidate{g.rows.length === 1 ? '' : 's'}</span>
                    </h2>
                  ) : (
                    <h2 className="visually-hidden">Candidates</h2>
                  )}
                  {g.rows.some((r) => r.judgements.length) && (
                    <Link to={`/compare?plan=${g.fingerprint}`} className="small sum-group__cmp">
                      Compare by category<span className="visually-hidden">: {g.planName}</span>
                    </Link>
                  )}
                </div>
              )}
              <SummaryTable rows={g.rows} sort={view.sort} dir={view.dir} onSort={sortBy} today={today} showRole={roles.length > 1 && !f.trackId && sets === 1} />
            </section>
          ))
        )}
      </>
    );
  }

  return (
    <div className="summary">
      <div className="no-print summary__screen">
        <PageHeader
          title="Summary"
          subtitle={rows.length ? 'Every candidate, the outcome and what is still missing.' : undefined}
          actions={
            <>
              {importer.trigger}
              {rows.length > 0 && (
                <MenuButton
                  label="Export"
                  icon="download"
                  variant="primary"
                  items={[
                    { label: 'Round report (Markdown)', icon: 'download', onSelect: () => void report('markdown'), disabled: !shown.length },
                    { label: 'Round report: print or save as PDF', icon: 'doc', onSelect: () => void report('print'), disabled: !shown.length },
                    { label: 'Table as CSV', icon: 'download', onSelect: () => void report('csv'), disabled: !shown.length },
                    { label: 'Panel file for everyone shown…', icon: 'folder', onSelect: () => setPanelFiles(true), disabled: !shown.length },
                  ]}
                />
              )}
            </>
          }
        />
        {importer.results}
        {body}
      </div>
      {printing && <RoundPrint items={printing} scope={scope} exportedBy={me ?? ''} />}
      <PanelFileDialog open={panelFiles} onClose={() => setPanelFiles(false)} refs={refs} what={`the ${shown.length} candidate${shown.length === 1 ? '' : 's'} shown`} />
    </div>
  );
}

function SortHeader({ k, label, sort, dir, onSort, className }: { k: SortKey; label: string; sort: SortKey; dir: SortDir; onSort: (k: SortKey) => void; className?: string }) {
  const active = sort === k;
  return (
    <th scope="col" className={className} aria-sort={active ? (dir === 'asc' ? 'ascending' : 'descending') : undefined}>
      <button type="button" className="cmp-sort" onClick={() => onSort(k)}>
        {label}
        <span className={`cmp-sort__ind${active ? '' : ' muted'}`} aria-hidden="true">
          {active ? (dir === 'asc' ? '▲' : '▼') : '↕'}
        </span>
      </button>
    </th>
  );
}

function SummaryTable({ rows, sort, dir, onSort, today, showRole }: { rows: RoundRow[]; sort: SortKey; dir: SortDir; onSort: (k: SortKey) => void; today: string; showRole: boolean }) {
  return (
    <div className="table-wrap sum-wrap" tabIndex={0} role="region" aria-label="Candidates">
      <table className="table sum-table">
        <thead>
          <tr>
            <SortHeader k="candidate" label="Candidate" sort={sort} dir={dir} onSort={onSort} />
            <SortHeader k="date" label="Date" sort={sort} dir={dir} onSort={onSort} />
            <SortHeader k="interviewers" label="Interviewers" sort={sort} dir={dir} onSort={onSort} />
            <SortHeader k="outcome" label="Outcome" sort={sort} dir={dir} onSort={onSort} />
            <SortHeader k="score" label="Score" sort={sort} dir={dir} onSort={onSort} />
            <th scope="col">Strengths and concerns</th>
            <SortHeader k="missing" label="Still missing" sort={sort} dir={dir} onSort={onSort} />
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <SummaryRow key={r.ref} row={r} today={today} showRole={showRole} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function SummaryRow({ row: r, today, showRole }: { row: RoundRow; today: string; showRole: boolean }) {
  const submitted = new Set(r.attendance.submitted.map((s) => nameKey(s.name)));
  return (
    <tr data-testid="summary-row" data-state={r.state}>
      <th scope="row" data-label="Candidate" className="sum-cand">
        <Link to={`/candidate/${r.ref}`} className="sum-cand__name">
          {r.name}
        </Link>
        <span className="small muted sum-cand__meta">{[r.requisition, showRole ? r.trackName : ''].filter(Boolean).join(' · ')}</span>
      </th>
      <td data-label="Date" className="sum-date">
        {r.date ? (
          <>
            {dayLabel(r.date, today)}
            {r.time && <span className="muted"> {r.time}</span>}
          </>
        ) : (
          <span className="muted">No date</span>
        )}
      </td>
      <td data-label="Interviewers" className="sum-who">
        {r.interviewers.length ? (
          <ul className="sum-names" role="list">
            {r.interviewers.map((n) => (
              <li key={n}>
                {submitted.has(nameKey(n)) ? <Icon name="check" className="icon--done" /> : <Icon name="circle" />}
                <span className="visually-hidden">{submitted.has(nameKey(n)) ? 'Submitted: ' : 'To come: '}</span>
                {n}
              </li>
            ))}
          </ul>
        ) : (
          <span className="muted">–</span>
        )}
      </td>
      <td data-label="Outcome" className="sum-outcome">
        <Outcome row={r} />
      </td>
      <td data-label="Score" className="sum-score">
        {r.score.pct == null ? (
          <span className="muted">{r.score.source === 'none' && r.judgements.length ? 'No question scores' : '–'}</span>
        ) : (
          <>
            <span className="sum-score__top">
              <span className="sum-score__pct tabular">{formatPct(r.score.pct)}</span>
              <BandBadge band={r.score.band} insufficientEvidence={r.score.insufficientEvidence} capped={r.score.capped} />
            </span>
            <span className="small muted sum-score__src">{r.score.label}</span>
            {r.score.spreadFlag && (
              <span className="small sum-score__spread">
                <Icon name="alert" /> Spread {Math.round(r.score.spread!)} points
              </span>
            )}
          </>
        )}
      </td>
      <td data-label="Strengths and concerns" className="sum-sc">
        <StrengthList items={r.strengths} kind="strength" />
        <StrengthList items={r.concerns} kind="concern" />
        {!r.strengths.length && !r.concerns.length && <span className="muted">–</span>}
      </td>
      <td data-label="Still missing" className="sum-missing">
        {r.state === 'decided' && !r.missing.length ? (
          <span className="sum-state sum-state--done">
            <Icon name="check" /> Nothing
          </span>
        ) : (
          <ul className="sum-missing__list" role="list">
            {r.missing.map((m) => (
              <li key={m}>
                <Icon name={m.startsWith('Waiting') ? 'clock' : m.startsWith('No panel') ? 'alert' : m.startsWith('Interview in') ? 'play' : 'circle'} /> {m}
              </li>
            ))}
          </ul>
        )}
      </td>
    </tr>
  );
}

function StrengthList({ items, kind }: { items: string[]; kind: 'strength' | 'concern' }) {
  if (!items.length) return null;
  const shown = items.slice(0, 2);
  return (
    <p className={`sum-sc__line sum-sc__line--${kind}`}>
      <Icon name={kind === 'strength' ? 'check' : 'alert'} />
      <span className="visually-hidden">{kind === 'strength' ? 'Strengths: ' : 'Concerns: '}</span>
      {shown.join(', ')}
      {items.length > 2 && <span className="muted sum-sc__more"> +{items.length - 2} more</span>}
    </p>
  );
}

/** TEAM-12, SUM-1: the panel decision, else each recommendation with its count; agreement or split said in words. */
export function Outcome({ row: r }: { row: RoundRow }) {
  const o = r.outcome;
  if (o.kind === 'decision') {
    return (
      <span className="sum-oc">
        <RecommendationBadge value={o.recommendation!} />
        <span className="small muted">Panel decision</span>
        {o.tally.length > 0 && <span className="small muted">Interviewers: {o.tally.map((t) => `${RECOMMENDATION_LABELS[t.recommendation]} ×${t.count}`).join(', ')}</span>}
      </span>
    );
  }
  if (o.kind === 'none') return <span className="muted">None yet</span>;
  return (
    <span className="sum-oc">
      <span className="sum-oc__tally">
        {o.tally.map((t) => (
          <span key={t.recommendation} className="sum-oc__item">
            <RecommendationBadge value={t.recommendation} />
            {t.count > 1 && <span className="sum-oc__n tabular">×{t.count}</span>}
          </span>
        ))}
      </span>
      <span className="small muted">{o.split ? 'Split' : r.judgements.filter((j) => !j.hidden).length > 1 ? 'All agree' : `From ${formatNames(r.judgements.filter((j) => !j.hidden).flatMap((j) => j.names))}`}</span>
    </span>
  );
}
