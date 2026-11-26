import { useMemo, useState, type ReactNode } from 'react';
import { Link, useParams } from 'react-router';
import { enteredJudgementInput, exportSessionFile, useCandidatePanel, useInterviewerName, usePanel, usePlans, useSessions, type PanelEntry, type PanelView } from '../db';
import { DecisionCard, PanelFileDialog } from './panel/PanelParts';
import { DecisionDialog } from './panel/DecisionDialog';
import { JudgementDialog } from './panel/JudgementDialog';
import { enteredLabel, type EnteredJudgementInput } from '../domain/decision';
import '../styles/pages/panel.css';
import { candidateKey, formatCandidateKey, shortFingerprint } from '../domain/plan';
import { RECOMMENDATION_LABELS } from '../domain/types';
import {
  Alert,
  BandBadge,
  Badge,
  Button,
  Card,
  DocLink,
  EmptyState,
  HelpLink,
  Icon,
  PageHeader,
  SessionStateBadge,
  downloadFile,
  formatAverage,
  formatCoverage,
  formatPct,
  useDocumentTitle,
  useToast,
} from '../ui';
import { ImportSessions } from './debrief/ImportSessions';
import { spreadText } from './debrief/model';
import '../styles/pages/debrief.css';
import { interviewersLabel, interviewersOf, nameKey } from '../domain/interviewers';
import { AI_LABEL, AI_NOT_A_DECISION } from '../domain/ai/report';
import '../styles/pages/print.css';
import { Attendance } from './team/Attendance';
import { whenLabel, localDay } from '../domain/team';

/** Route: /debrief/:sessionId (FLOW-26…FLOW-29, SCORE-11). */
export default function Debrief() {
  const { sessionId } = useParams();
  const view = usePanel(sessionId);
  useDocumentTitle('Debrief');

  let subtitle: string | undefined;
  let body: ReactNode;
  if (view === undefined) {
    body = (
      <p className="muted" aria-busy="true">
        Loading…
      </p>
    );
  } else if (view === null) {
    body = (
      <EmptyState title="No debrief is available for this interview." actions={<Link to="/">Go to the dashboard</Link>}>
        <p>The interview was not found on this device, or it has not been set up yet.</p>
      </EmptyState>
    );
  } else {
    const first = view.entries[0]?.session.candidate;
    subtitle = `Candidate ${first ? formatCandidateKey(first) : view.candidateKey} · ${view.plan.name} · comparison code ${shortFingerprint(view.plan.fingerprint)}`;
    body = <DebriefView view={view} sessionId={sessionId!} />;
  }

  return (
    <div className="debrief">
      <PageHeader title="Debrief" subtitle={subtitle} />
      {body}
    </div>
  );
}

function panelistLabel(e: PanelEntry): string {
  return e.session.origin === 'local' ? `${interviewersLabel(e.session)} (you)` : interviewersLabel(e.session);
}

/** TEAM-7…TEAM-11: the panel decision and judgements entered by hand, recorded from the debrief. */
function usePanelDialogs(sessionId: string) {
  const cp = useCandidatePanel(sessionId);
  const me = useInterviewerName();
  const { toast } = useToast();
  const [deciding, setDeciding] = useState(false);
  const [adding, setAdding] = useState(false);
  const [correcting, setCorrecting] = useState<{ sessionId: string; input: EnteredJudgementInput } | null>(null);
  const correct = async (id: string) => {
    try {
      setCorrecting({ sessionId: id, input: await enteredJudgementInput(id) });
    } catch (err) {
      toast(err instanceof Error ? err.message : 'It could not be opened.', 'error');
    }
  };
  const dialogs = cp ? (
    <>
      <DecisionDialog open={deciding} onClose={() => setDeciding(false)} panel={cp} me={me ?? ''} onSaved={() => toast('Panel decision saved.', 'success')} />
      <JudgementDialog open={adding} onClose={() => setAdding(false)} panel={cp} onSaved={() => toast('Judgement saved, labelled as entered by you.', 'success')} />
      <JudgementDialog open={!!correcting} onClose={() => setCorrecting(null)} panel={cp} correcting={correcting} onSaved={() => toast('Correction saved and recorded in the audit log.', 'success')} />
    </>
  ) : null;
  return { ready: !!cp, ref: cp?.data.ref ?? sessionId, decide: () => setDeciding(true), add: () => setAdding(true), correct, dialogs };
}

function DebriefView({ view, sessionId }: { view: PanelView; sessionId: string }) {
  const { toast } = useToast();
  const { panel, ownSessions, ownSubmitted } = view;
  // TEAM-6: an organiser who planned this for others is not a panelist: their own not-started record is not listed.
  const expectedKeys = new Set(view.attendance.expected.map(nameKey));
  const entries = view.entries.filter(
    (e) => !(e.session.origin === 'local' && e.session.state === 'planned' && expectedKeys.size && !interviewersOf(e.session).some((n) => expectedKeys.has(nameKey(n)))),
  );
  const visible = entries.filter((e) => e.scorecard);
  const hiddenCount = entries.filter((e) => e.hidden).length;
  const ownSubmittedSession = ownSessions.find((s) => s.state === 'submitted');
  const [busy, setBusy] = useState(false);
  const [panelFile, setPanelFile] = useState(false);
  const dlg = usePanelDialogs(sessionId);

  const exportOwn = async () => {
    if (!ownSubmittedSession) return;
    setBusy(true);
    try {
      const f = await exportSessionFile(ownSubmittedSession.id);
      downloadFile(f.fileName, f.mime, f.text);
      toast('Interview file exported. The export is recorded in the audit log.', 'success');
    } catch (err) {
      toast(err instanceof Error ? err.message : 'The export failed.', 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="dbf-actions no-print cluster">
        {ownSubmittedSession && (
          <>
            <Button icon="download" onClick={exportOwn} disabled={busy}>
              Export my interview file
            </Button>
            <Link to={`/scorecard/${ownSubmittedSession.id}`}>My scorecard</Link>
          </>
        )}
        <Button variant="ghost" icon="folder" onClick={() => setPanelFile(true)}>
          Export panel file
        </Button>
        <Link to={`/candidate/${dlg.ref}`}>Candidate summary</Link>
        <HelpLink slug="02-interview-flow" section="7-debrief">
          How the debrief works
        </HelpLink>
      </div>

      {view.independentScoring && !ownSubmitted && hiddenCount > 0 && (
        <Alert tone="info" title="Independent scoring is on: other interviewers’ scores are hidden.">
          <p>
            Their interviews show only their name and “submitted” until your own interview of this candidate, with these questions, is
            submitted. {ownSessions[0] && <Link to={`/interview/${ownSessions[0].id}`}>Go to your interview</Link>}{' '}
            <Link to="/admin?tab=device">Change this setting</Link> <DocLink req="FLOW-27" />
          </p>
        </Alert>
      )}

      {/* TEAM-9, TEAM-12: the panel decision is the outcome, shown next to the individual figures below. UX-9: recording it is the screen's primary action. */}
      <DecisionCard decision={view.record?.decision ?? null} onChange={dlg.ready ? dlg.decide : undefined} />

      {view.attendance.expected.length > 0 && (
        <section className="dbf-section" aria-labelledby="dbf-who-h">
          <div className="dbf-head">
            <h2 id="dbf-who-h">Interviewers</h2>
            <Button size="sm" icon="plus" onClick={dlg.add} disabled={!dlg.ready}>
              Add another interviewer’s judgement
            </Button>
          </div>
          {view.planned[0] && (
            <p className="small muted">
              Planned for {whenLabel(view.planned[0], localDay(new Date())).replace(/^No date yet$/, 'no particular date')} by {view.planned[0].organiser}.
            </p>
          )}
          <Attendance data={view.attendance} />
        </section>
      )}

      <section className="dbf-section" aria-labelledby="dbf-panel-h">
        <div className="dbf-head">
          <h2 id="dbf-panel-h">Panel</h2>
          {view.attendance.expected.length === 0 && (
            <Button size="sm" icon="plus" onClick={dlg.add} disabled={!dlg.ready}>
              Add another interviewer’s judgement
            </Button>
          )}
        </div>
        {visible.length > 0 ? (
          <div className="dbf-summary">
            <Card className="dbf-figure" title="Panel score (median)" level={3}>
              <p className="dbf-big tabular">{formatPct(panel.median)}</p>
              <p className="small">
                Median of {panel.members.length} panelist{panel.members.length === 1 ? '' : 's'}’ overall percentages.{' '}
                <DocLink req="SCORE-11" />
              </p>
            </Card>
            <Card className="dbf-figure" title="Spread" level={3}>
              <p className="dbf-big tabular">{spreadText(panel.spread, panel.spreadFlag)}</p>
              <p className="small">
                Highest {formatPct(panel.max)} minus lowest {formatPct(panel.min)}. <DocLink req="FLOW-28" />
              </p>
            </Card>
          </div>
        ) : (
          <p className="muted">No panel figures yet: they appear once submitted scorecards are visible.</p>
        )}
        {panel.spreadFlag && (
          <Alert tone="warning" title="The panel disagrees by more than 20 points.">
            <p>
              The spread between the highest and lowest overall percentage is {spreadText(panel.spread, true)}. Discuss the
              evidence behind the differences before deciding. <DocLink req="SCORE-11" />
            </p>
          </Alert>
        )}

        <div className="table-wrap" tabIndex={0} role="region" aria-label="Panelists">
          <table className="table">
            <caption>Panelists ({entries.length})</caption>
            <thead>
              <tr>
                <th scope="col">Panelist</th>
                <th scope="col">Status</th>
                <th scope="col" className="num">
                  Overall
                </th>
                <th scope="col" className="num">
                  Coverage
                </th>
                <th scope="col">Advisory band</th>
                <th scope="col">Recorded recommendation</th>
                <th scope="col">
                  <span className="visually-hidden">Scorecard link</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {entries.map((e) => (
                <PanelistRow key={e.session.id} entry={e} current={e.session.id === sessionId} onCorrect={dlg.correct} />
              ))}
            </tbody>
          </table>
        </div>
        {hiddenCount > 0 && (
          <p className="small muted">
            <Icon name="eye-off" /> {hiddenCount} panelist interview{hiddenCount === 1 ? ' is' : 's are'} hidden until your own
            interview is submitted.
          </p>
        )}

        {view.ai.length > 0 && (
          <div className="table-wrap dbf-ai" tabIndex={0} role="region" aria-label="AI second opinion figures">
            <table className="table">
              <caption>
                {AI_LABEL}: its own column, {AI_NOT_A_DECISION}. Not counted in the panel median or spread. <DocLink req="AI-10" />
              </caption>
              <thead>
                <tr>
                  <th scope="col">{AI_LABEL}</th>
                  <th scope="col" className="num">
                    Overall
                  </th>
                  <th scope="col" className="num">
                    Coverage
                  </th>
                  <th scope="col">Advisory band</th>
                  <th scope="col">
                    <span className="visually-hidden">Scorecard link</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {view.ai.map((a) => (
                  <tr key={a.session.id} className="sc-ai__col">
                    <th scope="row">
                      {a.result.model} <span className="muted small">· on the transcript of {interviewersLabel(a.session)}’s interview</span>
                      {a.outOfDate && (
                        <>
                          {' '}
                          <Badge tone="warning" icon="alert">
                            Out of date
                          </Badge>
                        </>
                      )}
                    </th>
                    <td className="num">
                      <strong>{formatPct(a.scorecard.overallPct)}</strong>
                    </td>
                    <td className="num">{formatCoverage(a.scorecard.coverage)}</td>
                    <td>
                      <BandBadge band={a.scorecard.band} insufficientEvidence={a.scorecard.insufficientEvidence} capped={a.scorecard.capApplied} />
                    </td>
                    <td>
                      <Link to={`/scorecard/${a.session.id}?section=ai`} className="no-print">
                        Details<span className="visually-hidden"> of the {AI_LABEL}</span>
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {visible.length > 0 && (
        <section className="dbf-section" aria-labelledby="dbf-cat-h">
          <h2 id="dbf-cat-h">Category averages side by side</h2>
          <div className="table-wrap" tabIndex={0} role="region" aria-label="Category averages">
            <table className="table table--compact">
              <caption>
                Average score (1–4) and percentage per category for each visible panelist.
              </caption>
              <thead>
                <tr>
                  <th scope="col">Category</th>
                  {panel.members.map((m) => (
                    <th scope="col" key={m.ref.id} className="num">
                      {m.ref.origin === 'local' ? `${interviewersLabel(m.ref)} (you)` : interviewersLabel(m.ref)}
                    </th>
                  ))}
                  {view.ai.map((a) => (
                    <th scope="col" key={`ai-${a.session.id}`} className="num sc-ai__col">
                      {AI_LABEL} <span className="muted">({AI_NOT_A_DECISION})</span>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {panel.categoryAverages.map((row) => (
                  <tr key={row.category.id}>
                    <th scope="row">
                      {row.category.name}
                      {row.category.mustHave && <span className="muted small"> (must-have)</span>}
                    </th>
                    {row.averages.map((avg, i) => (
                      <td key={i} className="num">
                        {avg == null ? (
                          <span className="muted">No answers</span>
                        ) : (
                          <>
                            <strong>{formatAverage(avg)}</strong> <span className="muted">({formatPct(row.pcts[i])})</span>
                          </>
                        )}
                      </td>
                    ))}
                    {view.ai.map((a) => {
                      const c = a.scorecard.categories.find((x) => x.category.id === row.category.id);
                      return (
                        <td key={`ai-${a.session.id}`} className="num sc-ai__col">
                          {c?.average == null ? (
                            <span className="muted">Not covered</span>
                          ) : (
                            <>
                              <strong>{formatAverage(c.average)}</strong> <span className="muted">({formatPct(c.pct)})</span>
                            </>
                          )}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="small muted">
            Averages are the plain mean of 1–4 scores; percentages are weighted. <DocLink req="SCORE-4" />
          </p>
        </section>
      )}

      {visible.length > 0 && (
        <section className="dbf-section" aria-labelledby="dbf-flag-h">
          <h2 id="dbf-flag-h">Flagged questions to discuss</h2>
          <div className="dbf-flags">
            {visible.map((e) => (
              <Card key={e.session.id} title={panelistLabel(e)} level={3}>
                {e.scorecard!.flagged.length ? (
                  <ul className="dbf-list">
                    {e.scorecard!.flagged.map((r) => (
                      <li key={r.question.id}>
                        <Icon name="flag" /> <strong>Q{r.index + 1}.</strong> {r.question.text}{' '}
                        <span className="muted">{r.skipped ? '(skipped)' : r.score ? `(score ${r.score})` : ''}</span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="muted">No flagged questions.</p>
                )}
              </Card>
            ))}
          </div>
        </section>
      )}

      <section className="dbf-section no-print" aria-labelledby="dbf-import-h">
        <h2 id="dbf-import-h">Add other panelists’ interviews</h2>
        <ImportSessions panel={{ candidateKey: view.candidateKey, fingerprint: view.plan.fingerprint }} />
        <OtherPlanNotice view={view} />
      </section>
      {dlg.dialogs}
      <PanelFileDialog open={panelFile} onClose={() => setPanelFile(false)} refs={[dlg.ref]} what="this candidate" />
    </>
  );
}

function PanelistRow({ entry, current, onCorrect }: { entry: PanelEntry; current: boolean; onCorrect: (id: string) => void }) {
  const s = entry.session;
  const sc = entry.scorecard;
  return (
    <tr aria-current={current ? 'true' : undefined}>
      <th scope="row">
        {panelistLabel(entry)}
        {interviewersOf(s).length > 1 && <span className="muted small"> · shared scorecard</span>}
        {entry.session.origin === 'imported' && <span className="muted small"> · imported</span>}
        {entry.session.origin === 'entered' && <span className="muted small dbf-entered"> {enteredLabel(entry.session)}</span>}
      </th>
      <td>
        <SessionStateBadge state={s.state} />
      </td>
      {entry.hidden ? (
        <td colSpan={5}>
          <span className="dbf-hidden">
            <Icon name="eye-off" /> Hidden until your own interview is submitted (blind scoring).
          </span>
        </td>
      ) : !sc ? (
        <td colSpan={5} className="muted">
          Not submitted yet: no scores to show.
        </td>
      ) : (
        <>
          {sc.answeredCount === 0 ? (
            <td colSpan={3} className="muted small">
              No question scores: not counted in the panel score.
            </td>
          ) : (
            <>
              <td className="num">
                <strong>{formatPct(sc.overallPct)}</strong>
              </td>
              <td className="num">{formatCoverage(sc.coverage)}</td>
              <td>
                <BandBadge band={sc.band} insufficientEvidence={sc.insufficientEvidence} capped={sc.capApplied} />
              </td>
            </>
          )}
          <td>
            {s.overall.recommendation ? (
              <Badge tone="neutral">{RECOMMENDATION_LABELS[s.overall.recommendation]}</Badge>
            ) : (
              <span className="muted">–</span>
            )}
          </td>
          <td>
            <span className="cluster no-print">
              <Link to={`/scorecard/${s.id}`}>
                Scorecard<span className="visually-hidden"> of {interviewersLabel(s)}</span>
              </Link>
              {s.origin === 'entered' && (
                <Button size="sm" variant="ghost" onClick={() => onCorrect(s.id)}>
                  Correct…<span className="visually-hidden"> {interviewersLabel(s)}’s judgement</span>
                </Button>
              )}
            </span>
          </td>
        </>
      )}
    </tr>
  );
}

/** FLOW-29: imported sessions for this candidate that used another plan are explained, not silently dropped. */
function OtherPlanNotice({ view }: { view: PanelView }) {
  const sessions = useSessions();
  const plans = usePlans();
  const others = useMemo(() => {
    if (!sessions || !plans) return [];
    const fpById = new Map(plans.map((p) => [p.id, p.fingerprint]));
    return sessions.filter(
      (s) => s.origin === 'imported' && candidateKey(s.candidate) === view.candidateKey && fpById.get(s.planId) !== view.plan.fingerprint,
    );
  }, [sessions, plans, view.candidateKey, view.plan.fingerprint]);
  if (!others.length) return null;
  return (
    <Alert tone="warning" title={`${others.length} imported interview${others.length === 1 ? '' : 's'} with this candidate used different questions.`}>
      <p>
        {others.map((s) => interviewersLabel(s)).join('; ')} asked this candidate different questions (a different comparison code), so{' '}
        {others.length === 1 ? 'that interview is' : 'those interviews are'} not part of this panel: scores for different questions are not
        comparable. <DocLink req="FLOW-29" />
      </p>
    </Alert>
  );
}
