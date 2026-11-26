import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link, useParams } from 'react-router';
import { RepoError, enteredJudgementInput, exportRoundReport, useCandidatePanel, useInterviewerName, type CandidatePanel } from '../db';
import { candidateDetail, roundRow, tallyText, type CandidateDetail, type RoundRow } from '../domain/round';
import { computeScorecard, formatAverage } from '../domain/scoring';
import { aiAnswers } from '../domain/ai/result';
import { AI_LABEL, AI_NOT_A_DECISION } from '../domain/ai/report';
import { enteredLabel, type EnteredJudgementInput } from '../domain/decision';
import { dayLabel, localDay } from '../domain/team';
import { formatNames } from '../domain/interviewers';
import { scoreLabel } from '../domain/rubric';
import { BandBadge, Badge, Button, EmptyState, Icon, MenuButton, PageHeader, buttonClass, formatCoverage, formatDateTime, formatPct, useDocumentTitle, useToast } from '../ui';
import { DecisionCard, PanelFileDialog, RecommendationBadge, WrittenSummaryEditor } from './panel/PanelParts';
import { DecisionDialog } from './panel/DecisionDialog';
import { JudgementDialog } from './panel/JudgementDialog';
import { RoundPrint } from './summary/RoundPrint';
import '../styles/pages/summary.css';
import '../styles/pages/panel.css';
import type { InterviewPlan } from '../domain/types';

/**
 * Route: /candidate/:ref (SUM-3, SUM-4, TEAM-7…TEAM-13). One page per candidate: the outcome and
 * why, the score and where it comes from, the written summary, each interviewer's judgement,
 * categories, strongest and weakest answers with the notes taken, flags and skips, and the AI
 * second opinion when there is one. The panel decision and other interviewers' judgements are
 * recorded from here.
 */
export default function CandidateSummary() {
  const { ref } = useParams();
  const panel = useCandidatePanel(ref);
  useDocumentTitle('Candidate summary');
  let title = 'Candidate summary';
  let subtitle: string | undefined;
  let body: ReactNode;
  let actions: ReactNode;
  if (panel === undefined) {
    body = (
      <p className="muted" aria-busy="true">
        Loading…
      </p>
    );
  } else if (panel === null) {
    body = (
      <EmptyState title="This candidate is not on this device." actions={<Link to="/summary">Go to the summary</Link>}>
        <p>It may have been removed by a deletion request or the retention purge.</p>
      </EmptyState>
    );
  } else {
    const row = roundRow(panel.data);
    title = row.name;
    const today = localDay(new Date());
    subtitle = [row.requisition, row.trackName, row.planName.startsWith(row.trackName) ? `${row.questionCount} questions` : `${row.planName} (${row.questionCount} questions)`, row.date ? `${dayLabel(row.date, today)}${row.time ? ` ${row.time}` : ''}` : ''].filter(Boolean).join(' · ');
    actions = <CandidateActions panel={panel} row={row} />;
    body = <CandidateView panel={panel} row={row} />;
  }
  return (
    <div className="cand">
      <div className="no-print">
        <PageHeader title={title} subtitle={subtitle} actions={actions} />
      </div>
      {body}
    </div>
  );
}

function CandidateActions({ panel, row }: { panel: CandidatePanel; row: RoundRow }) {
  const { toast } = useToast();
  const me = useInterviewerName();
  const [files, setFiles] = useState(false);
  const [printing, setPrinting] = useState(0);
  useEffect(() => {
    if (!printing) return;
    // The print layout stays mounted (hidden on screen) so "Save as PDF" can be repeated from the browser menu.
    const t = requestAnimationFrame(() => window.print());
    return () => cancelAnimationFrame(t);
  }, [printing]);
  const debriefTarget = panel.data.records.find((s) => s.origin === 'local') ?? panel.data.records[0];
  return (
    <>
      {debriefTarget && (
        <Link to={`/debrief/${debriefTarget.id}`} className={buttonClass('ghost')}>
          Debrief
        </Link>
      )}
      <MenuButton
        label="Export"
        icon="download"
        items={[
          { label: 'Panel file…', icon: 'folder', onSelect: () => setFiles(true) },
          {
            label: 'Print or save as PDF',
            icon: 'doc',
            onSelect: () =>
              void exportRoundReport([panel.data.ref], 'print', row.candidate).then(
                () => setPrinting((n) => n + 1),
                (err) => toast(err instanceof RepoError ? err.message : 'It could not be printed.', 'error'),
              ),
          },
        ]}
      />
      <PanelFileDialog open={files} onClose={() => setFiles(false)} refs={[panel.data.ref]} what={row.candidate} />
      {printing > 0 && <RoundPrint items={[{ row, detail: candidateDetail(panel.data) }]} scope={row.candidate} exportedBy={me ?? ''} />}
    </>
  );
}

function CandidateView({ panel, row }: { panel: CandidatePanel; row: RoundRow }) {
  const me = useInterviewerName();
  const { toast } = useToast();
  const [deciding, setDeciding] = useState(false);
  const [adding, setAdding] = useState(false);
  const [correcting, setCorrecting] = useState<{ sessionId: string; input: EnteredJudgementInput } | null>(null);
  const detail = useMemo(() => candidateDetail(panel.data), [panel.data]);
  const s = row.score;
  const toCome = row.attendance.toCome;

  return (
    <>
      {row.missing.length > 0 && (
        <p className="cand-missing small" data-testid="cand-missing">
          <Icon name="info" /> {row.missing.join(' · ')}
        </p>
      )}
      <div className="cand-top">
        <DecisionCard decision={row.decision} onChange={() => setDeciding(true)} />
        <section className="cand-score" aria-labelledby="cand-score-h" data-testid="cand-score">
          <h2 id="cand-score-h" className="cand-score__label">
            Score
          </h2>
          {s.pct == null ? (
            <p className="muted">{row.judgements.length ? 'No question scores yet.' : 'No judgements yet.'}</p>
          ) : (
            <>
              <p className="cand-score__pct tabular">{formatPct(s.pct)}</p>
              <p className="small">{s.label}</p>
              <p>
                <BandBadge band={s.band} insufficientEvidence={s.insufficientEvidence} capped={s.capped} />
              </p>
              {s.spreadFlag && (
                <p className="small">
                  <Icon name="alert" /> The interviewers differ by {Math.round(s.spread!)} points: discuss the evidence.
                </p>
              )}
            </>
          )}
          {row.outcome.tally.length > 0 && (
            <p className="small muted">
              Recommendations: {tallyText(row.outcome.tally)}
              {row.outcome.split ? ' (split)' : ''}
            </p>
          )}
        </section>
      </div>

      <WrittenSummaryEditor refId={panel.data.ref} summary={panel.data.record?.summary ?? null} />

      <section className="cand-section" aria-labelledby="cand-j-h">
        <div className="cand-section__head">
          <h2 id="cand-j-h">Judgements</h2>
          <Button icon="plus" onClick={() => setAdding(true)}>
            Add another interviewer’s judgement
          </Button>
        </div>
        <div className="table-wrap" tabIndex={0} role="region" aria-label="Judgements">
          <table className="table" aria-labelledby="cand-j-h">
            <thead>
              <tr>
                <th scope="col">Interviewer</th>
                <th scope="col">Recommendation</th>
                <th scope="col">Rating</th>
                <th scope="col" className="num">
                  Overall
                </th>
                <th scope="col">Advisory band</th>
                <th scope="col">Rationale</th>
                <th scope="col">
                  <span className="visually-hidden">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {row.judgements.map((j) => (
                <tr key={j.session.id} data-testid="judgement-row">
                  <th scope="row">
                    {formatNames(j.names)}
                    {j.session.origin === 'local' && <span className="muted small"> (here)</span>}
                    {j.entered && (
                      <span className="small muted cand-entered">
                        {enteredLabel(j.session)}, {formatDateTime(j.session.enteredAt)}
                      </span>
                    )}
                  </th>
                  {j.hidden ? (
                    <td colSpan={5} className="muted">
                      <Icon name="eye-off" /> Submitted; hidden until your own interview is submitted.
                    </td>
                  ) : (
                    <>
                      <td>{j.recommendation ? <RecommendationBadge value={j.recommendation} /> : '–'}</td>
                      <td>{j.session.overall.rating ? `${j.session.overall.rating} · ${scoreLabel(j.session.overall.rating)}` : '–'}</td>
                      <td className="num">{j.scorecard && j.scorecard.answeredCount ? <strong>{formatPct(j.scorecard.overallPct)}</strong> : <span className="muted small">No question scores</span>}</td>
                      <td>{j.scorecard && j.scorecard.answeredCount ? <BandBadge band={j.scorecard.band} insufficientEvidence={j.scorecard.insufficientEvidence} capped={j.scorecard.capApplied} /> : <span className="muted small">Not in the panel score</span>}</td>
                      <td className="pre-wrap cand-why">{j.session.overall.rationale}</td>
                    </>
                  )}
                  <td>
                    <span className="cluster">
                      {!j.hidden && (
                        <Link to={`/scorecard/${j.session.id}`} className="small">
                          Scorecard<span className="visually-hidden"> of {formatNames(j.names)}</span>
                        </Link>
                      )}
                      {j.entered && (
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={async () => {
                            try {
                              setCorrecting({ sessionId: j.session.id, input: await enteredJudgementInput(j.session.id) });
                            } catch (err) {
                              toast(err instanceof Error ? err.message : 'It could not be opened.', 'error');
                            }
                          }}
                        >
                          Correct…<span className="visually-hidden"> {formatNames(j.names)}’s judgement</span>
                        </Button>
                      )}
                    </span>
                  </td>
                </tr>
              ))}
              {toCome.map((n) => (
                <tr key={`tc-${n}`}>
                  <th scope="row">{n}</th>
                  <td colSpan={6} className="muted">
                    <Icon name="clock" /> Still to come
                  </td>
                </tr>
              ))}
              {!row.judgements.length && !toCome.length && (
                <tr>
                  <td colSpan={7} className="muted">
                    No judgements yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      <Details detail={detail} />
      <AiPart panel={panel} />

      <DecisionDialog open={deciding} onClose={() => setDeciding(false)} panel={panel} me={me ?? ''} onSaved={() => toast('Panel decision saved.', 'success')} />
      <JudgementDialog open={adding} onClose={() => setAdding(false)} panel={panel} onSaved={() => toast('Judgement saved, labelled as entered by you.', 'success')} />
      <JudgementDialog open={!!correcting} onClose={() => setCorrecting(null)} panel={panel} correcting={correcting} onSaved={() => toast('Correction saved and recorded in the audit log.', 'success')} />
    </>
  );
}

/** SUM-3: categories side by side, strongest and weakest answers with the notes taken, flags and skips. */
export function Details({ detail: d }: { detail: CandidateDetail }) {
  return (
    <>
      {d.columns.length > 0 && (
        <section className="cand-section" aria-labelledby="cand-cat-h">
          <h2 id="cand-cat-h">Categories</h2>
          <div className="table-wrap" tabIndex={0} role="region" aria-label="Categories">
            <table className="table table--compact" aria-labelledby="cand-cat-h">
              <thead>
                <tr>
                  <th scope="col">Category</th>
                  {d.columns.map((c) => (
                    <th scope="col" key={c.label} className="num">
                      {c.label}
                    </th>
                  ))}
                  <th scope="col" className="num">
                    Panel
                  </th>
                </tr>
              </thead>
              <tbody>
                {d.categories.map((c) => (
                  <tr key={c.name}>
                    <th scope="row">
                      {c.name}
                      {c.mustHave && <span className="muted small"> (must-have)</span>}
                    </th>
                    {c.averages.map((a, i) => (
                      <td key={i} className="num">
                        {formatAverage(a)}
                      </td>
                    ))}
                    <td className="num">
                      <strong>{formatAverage(c.figure)}</strong>
                      {c.figure != null && c.figure >= 3 && (
                        <>
                          {' '}
                          <Icon name="check" label="Strength" />
                        </>
                      )}
                      {c.figure != null && c.figure <= 2 && (
                        <>
                          {' '}
                          <Icon name="alert" label="Concern" />
                        </>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="small muted">Average score 1–4. “Panel” is the agreed score where there is one, otherwise the median of the interviewers’ averages.</p>
        </section>
      )}
      {(d.strongest.length > 0 || d.weakest.length > 0) && (
        <div className="cand-two">
          <Highlights id="cand-best-h" title="Strongest answers" items={d.strongest} empty="No answer averaged 3 or more." />
          <Highlights id="cand-worst-h" title="Weakest answers" items={d.weakest} empty="No answer averaged 2 or less." />
        </div>
      )}
      {(d.flagged.length > 0 || d.skipped.length > 0) && (
        <section className="cand-section" aria-labelledby="cand-fs-h">
          <h2 id="cand-fs-h">Flagged and skipped questions</h2>
          <ul className="cand-hl">
            {d.flagged.map((x) => (
              <li key={`f${x.index}`}>
                <Icon name="flag" /> <strong>Q{x.index + 1}.</strong> {x.text} <span className="muted small">(flagged by {formatNames(x.by)})</span>
              </li>
            ))}
            {d.skipped.map((x) => (
              <li key={`s${x.index}${x.by}`}>
                <Icon name="skip" /> <strong>Q{x.index + 1}.</strong> {x.text}{' '}
                <span className="muted small">
                  (skipped by {x.by}: {x.reason})
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </>
  );
}

function Highlights({ id, title, items, empty }: { id: string; title: string; items: CandidateDetail['strongest']; empty: string }) {
  return (
    <section className="cand-section" aria-labelledby={id}>
      <h2 id={id}>{title}</h2>
      {items.length ? (
        <ol className="cand-hl">
          {items.map((h) => (
            <li key={h.questionId}>
              <p className="cand-hl__q">
                <span className="cand-hl__score" title="Panel score for this question">
                  {formatAverage(h.score)}
                </span>
                <strong>Q{h.index + 1}.</strong> {h.text} <span className="muted small">({h.category})</span>
              </p>
              {h.by.length > 0 && (
                <ul className="cand-hl__by">
                  {h.by.map((b) => (
                    <li key={b.names.join()}>
                      <strong>{formatNames(b.names)}</strong> {b.score ?? '–'}
                      {b.notes.length > 0 && <span>: {b.notes.join(' / ')}</span>}
                    </li>
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ol>
      ) : (
        <p className="muted">{empty}</p>
      )}
    </section>
  );
}

/** AI-10, AI-11: the AI second opinion where there is one: its own section, never part of the panel figures. */
function AiPart({ panel }: { panel: CandidatePanel }) {
  const shared = (panel.data.record?.shared ?? []).filter((x) => x.aiSecondOpinion);
  if (!panel.ai.length && !shared.length) return null;
  const plan: InterviewPlan = panel.data.plan;
  return (
    <section className="cand-section" aria-labelledby="cand-ai-h">
      <h2 id="cand-ai-h">
        {AI_LABEL} <span className="muted small">({AI_NOT_A_DECISION}; not counted in the panel score)</span>
      </h2>
      <ul className="cand-hl">
        {panel.ai.map((a) => (
          <li key={a.session.id}>
            <strong>{formatPct(a.scorecard.overallPct)}</strong> <BandBadge band={a.scorecard.band} insufficientEvidence={a.scorecard.insufficientEvidence} capped={a.scorecard.capApplied} />{' '}
            <span className="small muted">
              {a.result.model}, on the transcript of {formatNames([a.session.interviewer.name])}’s interview · coverage {formatCoverage(a.scorecard.coverage)}
            </span>
            {a.outOfDate && (
              <>
                {' '}
                <Badge tone="warning" icon="alert">
                  Out of date
                </Badge>
              </>
            )}{' '}
            <Link to={`/scorecard/${a.session.id}?section=ai`} className="small">
              Details
            </Link>
          </li>
        ))}
        {shared.map((x) => {
          const r = x.aiSecondOpinion!;
          const sc = computeScorecard(plan, aiAnswers(plan, { questions: r.questions.map((q) => ({ ...q, coveredKeyPoints: [], redFlagsSeen: [], rationale: q.rationale ?? '', quotes: [] })) }));
          return (
            <li key={x.sessionId}>
              <strong>{formatPct(sc.overallPct)}</strong> <BandBadge band={sc.band} insufficientEvidence={sc.insufficientEvidence} capped={sc.capApplied} />{' '}
              <span className="small muted">
                {r.model}, on the transcript of {formatNames(x.interviewers)}’s interview (from a panel file)
              </span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
