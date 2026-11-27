import { useMemo, useState, type FormEvent } from 'react';
import { Link, useParams } from 'react-router';
import { RepoError, planMany, useMe, useRound, useRoundQuestionSet, useTeamOptions } from '../db';
import { Alert, Button, Checkbox, EmptyState, Field, Icon, PageHeader, TextArea, buttonClass, useDocumentTitle } from '../ui';
import { parseBulkPlan } from '../domain/bulkPlan';
import { formatCandidateKey } from '../domain/plan';
import { MAX_PLAN_NOTE, matchPanel, namesList } from '../domain/rounds';
import { dayLabel, localDay } from '../domain/team';
import '../styles/pages/dashboard.css';
import '../styles/pages/rounds.css';

const PREVIEW_PAGE = 60;

interface PreviewLine {
  line: number;
  candidate: string;
  requisitionId: string | null;
  date: string | null;
  time: string | null;
  note: string;
  panel: string[];
  panelNames: string[];
  /** People named who are not on the team yet; added as interviewers when the lines are planned. */
  joining: string[];
  problems: string[];
}

/**
 * Route: /rounds/:roundId/plan (TEAM-15, ROUND-4). Paste or type one line per candidate (tab- or
 * comma-separated: candidate, then optionally date, time, panel and note; a header line is optional and
 * can add a requisition column). The panel is matched against the round's team by email, full name or
 * first name; someone with access who is not on the team yet is added as an interviewer. The preview
 * shows each line's problems; "Plan" creates every ready line at once with the round's questions, or
 * nothing.
 */
export default function PlanSeveral() {
  useDocumentTitle('Plan several interviews');
  const { roundId = '' } = useParams();
  const me = useMe();
  const round = useRound(roundId);
  const set = useRoundQuestionSet(roundId);
  const options = useTeamOptions(roundId, !!round?.canManage);
  const [text, setText] = useState('');
  const [note, setNote] = useState('');
  const [recording, setRecording] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ message: string; details: string[] } | null>(null);
  const [done, setDone] = useState<number | null>(null);
  const today = localDay(new Date());
  const parsed = useMemo(() => parseBulkPlan(text), [text]);

  const lines = useMemo((): PreviewLine[] => {
    if (!round || !me) return [];
    const team = round.team.filter((m) => m.active);
    const others = (options ?? []).filter((o) => !team.some((m) => m.id === o.id));
    const meOnTeam = team.some((m) => m.id === me.id);
    return parsed.lines.map((l) => {
      const problems = [...l.problems];
      let panel: string[] = [];
      let joining: string[] = [];
      if (!l.interviewers.length) {
        if (meOnTeam) panel = [me.id];
        else problems.push('Name the interviewers.');
      } else {
        const m = matchPanel(l.interviewers, team);
        panel = m.ids;
        if (m.kind === 'problems') {
          // Not on the team: someone with access can join it as an interviewer.
          const extra = m.unknown.length ? matchPanel(m.unknown, others) : { kind: 'ok' as const, ids: [] };
          panel = [...panel, ...extra.ids];
          joining = extra.ids;
          const unknown = extra.kind === 'problems' ? extra.unknown : [];
          const ambiguous = [...m.ambiguous, ...(extra.kind === 'problems' ? extra.ambiguous : [])];
          if (unknown.length) problems.push(`${namesList(unknown.map((n) => `“${n}”`))} ${unknown.length === 1 ? 'is' : 'are'} not on the team${round.canManage ? ' and cannot be added' : ''}.`);
          if (ambiguous.length) problems.push(`${namesList(ambiguous.map((n) => `“${n}”`))} could be more than one person: use the email address.`);
        }
      }
      const names = panel.map((id) => team.find((m) => m.id === id)?.name ?? others.find((o) => o.id === id)?.name ?? '?');
      return { line: l.line, candidate: l.candidate, requisitionId: l.requisitionId, date: l.date, time: l.time, note: l.note, panel, panelNames: names, joining, problems };
    });
  }, [parsed, round, me, options]);
  const ready = lines.filter((l) => !l.problems.length);
  const bad = lines.length - ready.length;
  const joining = [...new Set(ready.flatMap((l) => l.joining))];

  if (round === null) {
    return (
      <>
        <PageHeader title="Plan several interviews" />
        <EmptyState title="This round does not exist, or you are not on its team." />
      </>
    );
  }
  if (round && !round.canPlan) {
    return (
      <>
        <PageHeader title="Plan several interviews" />
        <EmptyState title={round.state === 'closed' ? 'This round is closed, so no interviews can be planned in it.' : 'Only the round’s organisers plan its interviews.'} />
      </>
    );
  }

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!ready.length) return;
    setBusy(true);
    try {
      const ids = await planMany(roundId, {
        lines: ready.map((l) => ({ candidate: l.candidate, requisitionId: l.requisitionId, date: l.date, time: l.time, panel: l.panel, note: l.note || note.trim() })),
        recordingNotice: recording,
        addToTeam: joining,
      });
      setDone(ids.length);
      requestAnimationFrame(() => document.getElementById('ps-done')?.focus());
    } catch (err) {
      setError(err instanceof RepoError ? { message: err.message, details: err.details } : { message: 'The interviews could not be planned.', details: [] });
    } finally {
      setBusy(false);
    }
  };

  const subtitle = round ? <Link to={`/rounds/${roundId}`}>{round.name}</Link> : undefined;
  if (done !== null) {
    return (
      <>
        <PageHeader title="Plan several interviews" subtitle={subtitle} />
        <section className="card ps-done" aria-labelledby="ps-done" data-testid="plan-done">
          <h2 id="ps-done" tabIndex={-1}>
            <Icon name="check" /> {done} interview{done === 1 ? '' : 's'} planned
          </h2>
          <p className="muted">They all have the round’s questions, so the candidates can be compared. Everyone on their panels sees them on their Dashboard now.</p>
          <div className="cluster-lg">
            <Link to={`/rounds/${roundId}`} className={buttonClass('primary', 'lg')}>
              See the round’s interviews
            </Link>
            <button
              type="button"
              className="pc-linkbtn"
              onClick={() => {
                setDone(null);
                setText('');
              }}
            >
              Plan more
            </button>
          </div>
        </section>
      </>
    );
  }

  return (
    <>
      <PageHeader title="Plan several interviews" subtitle={subtitle} />
      <form className="card ps" onSubmit={submit} noValidate aria-label="Plan several interviews">
        <Field
          label="Candidates, one per line"
          hint="Candidate, then optionally date, time, interviewers (emails or names from the team, separated by ; or /) and a note. Paste from a spreadsheet; a header line is fine."
        >
          <TextArea
            id="ps-lines"
            rows={8}
            value={text}
            onChange={(e) => setText(e.target.value)}
            spellCheck={false}
            className="mono ps-lines"
            placeholder={'Ana Diaz, 2026-12-01, 09:30, ben@example.com; Cy Park, Room 4\nBo Li, 2026-12-01, 11:00\nChen Wu'}
          />
        </Field>
        <div className="ps-shared">
          <Field label="Note for the interviewers" hint="Used for lines without a note of their own.">
            <TextArea id="ps-note" rows={2} value={note} maxLength={MAX_PLAN_NOTE} onChange={(e) => setNote(e.target.value)} />
          </Field>
          <Checkbox label="These interviews will be recorded or transcribed" description="The consent text on the ready screen then says so." checked={recording} onChange={(e) => setRecording(e.target.checked)} />
        </div>
        {set && (
          <p className="small muted">
            <Icon name="info" /> Every interview gets the round’s {set.questions.length} questions{set.fixed ? '' : '; they are fixed once these are planned'}. For one candidate with different questions, use New interview.
          </p>
        )}
        {error && (
          <Alert tone="danger" title={error.message} role="alert">
            {error.details.length > 0 && (
              <ul className="small">
                {error.details.slice(0, 10).map((d, i) => (
                  <li key={i}>{d}</li>
                ))}
              </ul>
            )}
          </Alert>
        )}
        <div className="ps-footer">
          <Button type="submit" variant="primary" size="lg" disabled={busy || !ready.length}>
            {ready.length ? `Plan ${ready.length} interview${ready.length === 1 ? '' : 's'}` : 'Plan'}
            {bad > 0 && ready.length > 0 ? `, leave out ${bad} line${bad === 1 ? '' : 's'}` : ''}
          </Button>
          <Link to={`/rounds/${roundId}`} className={buttonClass('ghost')}>
            Cancel
          </Link>
          {joining.length > 0 && (
            <span className="small">
              <Icon name="info" /> {joining.length} {joining.length === 1 ? 'person joins' : 'people join'} the team as interviewer{joining.length === 1 ? '' : 's'}.
            </span>
          )}
        </div>
        {lines.length > 0 && (
          <section className="ps-preview" aria-labelledby="ps-preview-title">
            <h2 id="ps-preview-title" className="ps-preview__title" aria-live="polite">
              {ready.length} ready{bad ? ` · ${bad} with problems` : ''}
              {parsed.tooMany && <span className="muted small"> · only the first 200 lines are read</span>}
            </h2>
            <div className="table-wrap" tabIndex={0} role="region" aria-label="Preview">
              <table className="table table--compact">
                <thead>
                  <tr>
                    <th scope="col" className="num">
                      Line
                    </th>
                    <th scope="col">Candidate</th>
                    <th scope="col">When</th>
                    <th scope="col">Interviewers</th>
                    <th scope="col">Problems</th>
                  </tr>
                </thead>
                <tbody>
                  {[...lines]
                    .sort((a, b) => Number(!a.problems.length) - Number(!b.problems.length) || a.line - b.line)
                    .slice(0, PREVIEW_PAGE)
                    .map((l) => (
                      <tr key={l.line} className={l.problems.length ? 'ps-bad' : undefined} data-testid="preview-line">
                        <td className="num">{l.line}</td>
                        <th scope="row">{l.candidate ? formatCandidateKey({ initials: l.candidate, requisitionId: l.requisitionId }) : <span className="muted">–</span>}</th>
                        <td>{l.date ? `${dayLabel(l.date, today)}${l.time ? ` ${l.time}` : ''}` : <span className="muted">No date</span>}</td>
                        <td>
                          {l.panelNames.length ? namesList(l.panelNames) : <span className="muted">–</span>}
                          {l.joining.length > 0 && <span className="small muted"> (joins the team)</span>}
                        </td>
                        <td>
                          {l.problems.length ? (
                            <span className="ps-problem">
                              <Icon name="alert" /> {l.problems.join(' ')}
                            </span>
                          ) : (
                            <span className="ps-ok">
                              <Icon name="check" /> Ready
                            </span>
                          )}
                        </td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
            {lines.length > PREVIEW_PAGE && <p className="small muted">…and {lines.length - PREVIEW_PAGE} more lines.</p>}
          </section>
        )}
      </form>
    </>
  );
}
