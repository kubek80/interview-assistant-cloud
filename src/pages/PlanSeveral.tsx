import { useMemo, useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import { RepoError, planSeveral, setInterviewerName, useInterviewerName, useLastTrackId, useTracks } from '../db';
import { Alert, Button, Checkbox, Field, Icon, PageHeader, Select, TextArea, TextInput, buttonClass, useDocumentTitle } from '../ui';
import { MAX_NOTE } from '../domain/team';
import { parseBulkPlan } from '../domain/bulkPlan';
import { formatCandidateKey } from '../domain/plan';
import { formatNames } from '../domain/interviewers';
import { dayLabel, localDay } from '../domain/team';
import { useExportInvitations } from './dashboard/Upcoming';
import '../styles/pages/dashboard.css';

const PREVIEW_PAGE = 50;

/**
 * Route: /plan (TEAM-15). Paste or type one line per candidate (tab- or comma-separated: candidate,
 * date, time, requisition id, interviewers; a header line is optional), choose the role once, check
 * the preview, and plan them all. Nothing is created until "Plan" is pressed. Then the invitations
 * for all of them are one click away.
 */
export default function PlanSeveral() {
  useDocumentTitle('Plan several interviews');
  const tracks = useTracks();
  const lastTrack = useLastTrackId();
  const storedName = useInterviewerName();
  const [trackId, setTrackId] = useState('');
  const [text, setText] = useState('');
  const [same, setSame] = useState(true);
  const [note, setNote] = useState('');
  const [recording, setRecording] = useState(false);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ message: string; details: string[] } | null>(null);
  const [done, setDone] = useState<{ ids: string[]; sets: number } | null>(null);
  const exportIds = useExportInvitations();
  const role = trackId || lastTrack || tracks?.[0]?.id || '';
  const needsName = storedName !== undefined && !storedName?.trim();
  const parsed = useMemo(() => parseBulkPlan(text), [text]);
  const ready = parsed.lines.filter((l) => !l.problems.length);
  const bad = parsed.lines.length - ready.length;
  const today = localDay(new Date());

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (needsName && !name.trim()) {
      setError({ message: 'Enter your name first.', details: [] });
      document.getElementById('ps-name')?.focus();
      return;
    }
    if (!ready.length) return;
    setBusy(true);
    try {
      if (needsName) await setInterviewerName(name);
      const r = await planSeveral({ trackId: role, sameQuestions: same, lines: ready, note: note.trim(), recordingNotice: recording });
      setDone({ ids: r.invitationIds, sets: r.planIds.length });
      requestAnimationFrame(() => document.getElementById('ps-done')?.focus());
    } catch (err) {
      setError(err instanceof RepoError ? { message: err.message, details: err.details } : { message: 'The interviews could not be planned.', details: [] });
    } finally {
      setBusy(false);
    }
  };

  if (done) {
    return (
      <>
        <PageHeader title="Plan several interviews" />
        <section className="card ps-done" aria-labelledby="ps-done" data-testid="plan-done">
          <h2 id="ps-done" tabIndex={-1}>
            <Icon name="check" /> {done.ids.length} interview{done.ids.length === 1 ? '' : 's'} planned
          </h2>
          <p className="muted">
            {done.sets === 1 ? 'They all have the same questions, so the candidates can be compared.' : `Each has its own questions (${done.sets} question sets).`} They are under
            Upcoming on the Dashboard.
          </p>
          <div className="cluster-lg">
            <Button variant="primary" size="lg" icon="download" onClick={() => exportIds(done.ids)}>
              Export invitations for all of them
            </Button>
            <Link to="/">Go to the Dashboard</Link>
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
      <PageHeader title="Plan several interviews" />
      <form className="card ps" onSubmit={submit} noValidate aria-label="Plan several interviews">
        <div className="ps-top">
          {needsName && (
            <Field label="Your name" required>
              <TextInput id="ps-name" value={name} onChange={(e) => setName(e.target.value.slice(0, 200))} autoComplete="name" />
            </Field>
          )}
          <Field label="Role">
            <Select id="ps-role" value={role} onChange={(e) => setTrackId(e.target.value)} options={(tracks ?? []).map((t) => ({ value: t.id, label: t.name }))} />
          </Field>
          <fieldset className="ps-same">
            <legend className="field__label">Questions</legend>
            <label className="ps-radio">
              <input type="radio" name="ps-same" checked={same} onChange={() => setSame(true)} /> The same for everyone, so they can be compared
            </label>
            <label className="ps-radio">
              <input type="radio" name="ps-same" checked={!same} onChange={() => setSame(false)} /> A separate draw for each
            </label>
          </fieldset>
        </div>
        <Field label="Candidates, one per line" hint="Candidate, then optionally date, time, requisition id and interviewers. Paste from a spreadsheet; a header line is fine.">
          <TextArea
            id="ps-lines"
            rows={8}
            value={text}
            onChange={(e) => setText(e.target.value)}
            spellCheck={false}
            className="mono ps-lines"
            placeholder={'Ana Diaz, 2026-12-01, 09:30, REQ-42, Ben Ng; Cy Park\nBo Li, 2026-12-01, 11:00, REQ-42\nChen Wu'}
          />
        </Field>

        <div className="ps-shared">
          <Field label="Note for the interviewers" hint="The same for every interview, e.g. the room or the video link.">
            <TextArea id="ps-note" rows={2} value={note} maxLength={MAX_NOTE} onChange={(e) => setNote(e.target.value)} />
          </Field>
          <Checkbox label="These interviews will be recorded or transcribed" description="The consent text on the ready screen then says so." checked={recording} onChange={(e) => setRecording(e.target.checked)} />
        </div>
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
          <Link to="/" className={buttonClass('ghost')}>
            Cancel
          </Link>
        </div>
        {parsed.lines.length > 0 && (
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
                  {[...parsed.lines].sort((a, b) => Number(!a.problems.length) - Number(!b.problems.length) || a.line - b.line).slice(0, PREVIEW_PAGE).map((l) => (
                    <tr key={l.line} className={l.problems.length ? 'ps-bad' : undefined}>
                      <td className="num">{l.line}</td>
                      <th scope="row">{l.candidate ? formatCandidateKey({ initials: l.candidate, requisitionId: l.requisitionId }) : <span className="muted">–</span>}</th>
                      <td>{l.date ? `${dayLabel(l.date, today)}${l.time ? ` ${l.time}` : ''}` : <span className="muted">No date</span>}</td>
                      <td>{l.interviewers.length ? formatNames(l.interviewers) : <span className="muted">You</span>}</td>
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
            {parsed.lines.length > PREVIEW_PAGE && <p className="small muted">…and {parsed.lines.length - PREVIEW_PAGE} more lines.</p>}
          </section>
        )}

      </form>
    </>
  );
}
