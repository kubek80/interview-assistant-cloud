import { useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { useComparison, usePlanChoices, useTracks } from '../db';
import { formatCandidateKey, shortFingerprint } from '../domain/plan';
import { RECOMMENDATION_LABELS } from '../domain/types';
import type { InterviewPlan, PanelDecision } from '../domain/types';
import {
  Alert,
  BandBadge,
  DocLink,
  EmptyState,
  Field,
  HelpLink,
  Icon,
  PageHeader,
  Select,
  formatAverage,
  formatDate,
  formatPct,
  useDocumentTitle,
} from '../ui';
import { blindedCount, candidateBlocks, type CandidateLine, type SortDir, type SortKey } from './compare/model';
import { RecommendationBadge } from './panel/PanelParts';
import '../styles/pages/panel.css';
import '../styles/pages/compare.css';
import { interviewersLabel } from '../domain/interviewers';

/** Route: /compare (FLOW-30). */
export default function Comparison() {
  useDocumentTitle('Compare candidates');
  const choices = usePlanChoices();
  const tracks = useTracks();
  // The fingerprint (shown as the "comparison code") is a hash of the question set, not candidate data (PRIV-3), so it may live in the URL.
  const [params, setParams] = useSearchParams();
  const fingerprint = params.get('plan') ?? '';
  const choice = choices?.find((c) => c.fingerprint === fingerprint);
  const trackName = (id: string) => tracks?.find((t) => t.id === id)?.name ?? id;

  return (
    <div className="compare">
      <PageHeader title="Compare candidates" subtitle="Candidates asked the same questions, side by side by category." />

      {choices === undefined ? (
        <p className="muted" aria-busy="true">
          Loading…
        </p>
      ) : choices.length === 0 ? (
        <EmptyState title="Nothing to compare yet." actions={<Link to="/">Go to the dashboard</Link>}>
          <p>Submit interviews that use the same questions, or import other interviewers’ files in a debrief, to compare candidates.</p>
        </EmptyState>
      ) : (
        <div className="cmp-choose">
          <Field
            label="Question set"
            hint={
              <>
                Only candidates asked exactly the same questions can be compared, so the scores mean the same thing. <DocLink req="FLOW-30" />
              </>
            }
          >
            <Select
              value={choice ? fingerprint : ''}
              placeholder="Choose a question set…"
              onChange={(e) => {
                const next = new URLSearchParams(params);
                if (e.target.value) next.set('plan', e.target.value);
                else next.delete('plan');
                setParams(next, { replace: true });
              }}
              options={choices.map((c) => ({
                value: c.fingerprint,
                label: `${c.plan.name} · ${trackName(c.plan.trackId)} · ${c.submittedCount} submitted · code ${shortFingerprint(c.fingerprint)}`,
              }))}
            />
          </Field>
        </div>
      )}

      {choice && <ComparisonMatrix fingerprint={choice.fingerprint} submittedCount={choice.submittedCount} trackName={trackName(choice.plan.trackId)} />}
    </div>
  );
}

function ComparisonMatrix({ fingerprint, submittedCount, trackName }: { fingerprint: string; submittedCount: number; trackName: string }) {
  const data = useComparison(fingerprint);
  const [sortKey, setSortKey] = useState<SortKey>('overall');
  const [dir, setDir] = useState<SortDir>('desc');
  const rows = data?.rows ?? [];
  // TEAM-12: one block per candidate, led by the agreed scores or the panel median when there are any.
  const blocks = useMemo(() => {
    if (!data) return [];
    const sign = dir === 'asc' ? 1 : -1;
    return candidateBlocks(data.plan, data.rows, data.decisions).sort((a, b) => {
      if (sortKey === 'candidate') return sign * a.candidateKey.localeCompare(b.candidateKey);
      if (a.main == null && b.main == null) return a.candidateKey.localeCompare(b.candidateKey);
      if (a.main == null) return 1;
      if (b.main == null) return -1;
      return sign * (a.main - b.main) || a.candidateKey.localeCompare(b.candidateKey);
    });
  }, [data, sortKey, dir]);

  if (data === undefined) return <p className="muted" aria-busy="true">Loading…</p>;
  if (data === null) return <p className="muted">This question set is no longer on this device.</p>;

  const blinded = blindedCount({ submittedCount }, data.rows.length);
  const categories = categoriesWithQuestions(data.plan);

  const toggle = (key: SortKey) => {
    if (sortKey === key) setDir(dir === 'desc' ? 'asc' : 'desc');
    else {
      setSortKey(key);
      setDir(key === 'overall' ? 'desc' : 'asc');
    }
  };
  const ariaSort = (key: SortKey) => (sortKey === key ? (dir === 'asc' ? 'ascending' : 'descending') : undefined);

  return (
    <section className="cmp-matrix stack" aria-labelledby="cmp-h">
      <div className="spread">
        <h2 id="cmp-h">
          {data.plan.name} <span className="muted small mono">{shortFingerprint(fingerprint)}</span>
        </h2>
        <p className="small muted">
          {trackName} · {data.plan.questions.length} questions · set up {formatDate(data.plan.lockedAt)}
        </p>
      </div>

      {blinded > 0 && (
        <Alert tone="info" title={`${blinded} interview${blinded === 1 ? '' : 's'} from other interviewers ${blinded === 1 ? 'is' : 'are'} not shown yet (blind scoring).`}>
          <p>
            They appear once your own interview of that candidate is submitted. <DocLink req="FLOW-27" />
          </p>
        </Alert>
      )}

      {rows.length === 0 ? (
        <EmptyState title="No submitted interviews with these questions yet.">
          <p>Interviews appear here once they are submitted.</p>
        </EmptyState>
      ) : (
        <>
          <div className="table-wrap">
            <table className="table table--compact cmp-table">
              <caption>
                Candidates × categories. Each category cell shows the average score (1–4) and the weighted percentage.
              </caption>
              <thead>
                <tr>
                  <th scope="col" aria-sort={ariaSort('candidate')}>
                    <button type="button" className="cmp-sort" onClick={() => toggle('candidate')}>
                      Candidate
                      <SortIndicator active={sortKey === 'candidate'} dir={dir} />
                    </button>
                  </th>
                  <th scope="col">Figures</th>
                  <th scope="col" className="num" aria-sort={ariaSort('overall')}>
                    <button type="button" className="cmp-sort" onClick={() => toggle('overall')}>
                      Overall
                      <SortIndicator active={sortKey === 'overall'} dir={dir} />
                    </button>
                  </th>
                  <th scope="col">Advisory band</th>
                  <th scope="col">Recommendation</th>
                  <th scope="col">Panel decision</th>
                  {categories.map((c) => (
                    <th scope="col" key={c.id} className="num">
                      {c.name}
                      {c.mustHave && (
                        <span className="cmp-must">
                          <Icon name="alert" /> must-have
                        </span>
                      )}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {blocks.map((b) =>
                  b.lines.map((line, i) => (
                    <MatrixRow key={line.row?.session.id ?? `${b.candidateKey}-${line.source}`} line={line} first={i === 0} candidate={formatCandidateKey(b.lines.find((l) => l.row)!.row!.session.candidate)} decision={b.decision} categoryIds={categories.map((c) => c.id)} />
                  )),
                )}
              </tbody>
            </table>
          </div>
          <p className="small muted cluster">
            <span>
              <Icon name="check" /> strength (average 3.0 or more) · <Icon name="alert" /> concern (2.0 or less)
            </span>
            <DocLink req="SCORE-5" />
            <HelpLink slug="04-scoring" section="bands">
              Band thresholds
            </HelpLink>
            <DocLink req="SCORE-6" />
          </p>
        </>
      )}
    </section>
  );
}

function SortIndicator({ active, dir }: { active: boolean; dir: SortDir }) {
  if (!active) return <span className="cmp-sort__ind muted" aria-hidden="true">↕</span>;
  return (
    <span className="cmp-sort__ind" aria-hidden="true">
      {dir === 'asc' ? '▲' : '▼'}
    </span>
  );
}

function MatrixRow({ line, first, candidate, decision, categoryIds }: { line: CandidateLine; first: boolean; candidate: string; decision: PanelDecision | null; categoryIds: string[] }) {
  const s = line.row?.session;
  return (
    <tr className={first ? 'cmp-first' : 'cmp-more'}>
      <th scope="row">
        {s ? <Link to={`/scorecard/${s.id}`}>{candidate}</Link> : <span>{candidate}</span>}
      </th>
      <td>
        {s ? (
          <>
            {interviewersLabel(s)}
            {s.origin === 'imported' && <span className="muted small"> (imported)</span>}
            {s.origin === 'entered' && <span className="muted small"> (entered by {s.enteredBy})</span>}
            <span className="muted small"> · one interviewer’s</span>
          </>
        ) : (
          <strong>{line.label}</strong>
        )}
      </td>
      <td className="num">
        <strong>{formatPct(line.pct)}</strong>
      </td>
      <td>{line.source === 'median' ? <span className="muted small">–</span> : <BandBadge band={line.band} insufficientEvidence={line.insufficientEvidence} capped={line.capped} />}</td>
      <td>{s?.overall.recommendation ? RECOMMENDATION_LABELS[s.overall.recommendation] : '–'}</td>
      <td>{decision ? <RecommendationBadge value={decision.recommendation} /> : <span className="muted small">None yet</span>}</td>
      {categoryIds.map((id) => {
        const avg = line.averages.get(id) ?? null;
        const c = line.row?.scorecard.categories.find((x) => x.category.id === id);
        if (avg == null)
          return (
            <td key={id} className="num muted">
              {c?.noEvidence ? (
                <>
                  <Icon name="alert" /> no evidence
                </>
              ) : (
                'No answers'
              )}
            </td>
          );
        return (
          <td key={id} className="num">
            {avg >= 3 && (
              <>
                <Icon name="check" />
                <span className="visually-hidden">Strength: </span>{' '}
              </>
            )}
            {avg <= 2 && (
              <>
                <Icon name="alert" />
                <span className="visually-hidden">Concern: </span>{' '}
              </>
            )}
            <strong>{formatAverage(avg)}</strong>
            {c && <span className="muted"> ({formatPct(c.pct)})</span>}
          </td>
        );
      })}
    </tr>
  );
}

function categoriesWithQuestions(plan: InterviewPlan) {
  const used = new Set(plan.questions.map((q) => q.categoryId));
  return plan.categories.filter((c) => used.has(c.id));
}
