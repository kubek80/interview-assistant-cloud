import { useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { RepoError, createRound, useRounds, useTracks } from '../db';
import { ROUND_ROLE_LABELS, type Me, type RoundSummary } from '../shared/api';
import { Badge, Button, Dialog, EmptyState, Field, Icon, PageHeader, Select, TextInput, useDocumentTitle } from '../ui';
import { MAX_REQUISITION, MAX_ROUND_NAME, namesList } from '../domain/rounds';
import '../styles/pages/rounds.css';

/**
 * Route: /rounds (ROUND-1, ROUND-2). The hiring rounds the signed-in person can see (administrators:
 * all), each with its state, the person's role in it, the team and counts of its interviews. Organisers
 * and administrators create a round here: a name, the role and an optional requisition id.
 */
export default function Rounds({ me }: { me: Me }) {
  useDocumentTitle('Rounds');
  const rounds = useRounds({ all: me.role === 'admin' });
  const canCreate = me.permissions.includes('rounds.create');
  const [params, setParams] = useSearchParams();
  const [creating, setCreating] = useState(params.get('create') === '1');
  useEffect(() => {
    if (params.get('create') === '1') setParams({}, { replace: true });
  }, [params, setParams]);
  const open = rounds?.filter((r) => r.state === 'open') ?? [];
  const closed = rounds?.filter((r) => r.state === 'closed') ?? [];

  return (
    <>
      <PageHeader
        title="Rounds"
        actions={
          canCreate && rounds && rounds.length > 0 ? (
            <Button variant="primary" icon="plus" onClick={() => setCreating(true)}>
              New round
            </Button>
          ) : undefined
        }
      />
      {rounds === undefined ? (
        <p className="muted">Loading…</p>
      ) : rounds.length === 0 ? (
        canCreate ? (
          <section className="card dash-welcome" aria-labelledby="rounds-first">
            <h2 id="rounds-first">Start a hiring round</h2>
            <p>A round is one role you are hiring for, with its own team and question set. Give it a name and choose the role: the questions are drawn for you, and you can change them.</p>
            <Button variant="primary" size="lg" icon="plus" onClick={() => setCreating(true)}>
              New round
            </Button>
          </section>
        ) : (
          <EmptyState title="You are not on any round yet.">
            <p>An organiser adds you to a round’s team; it then appears here and on your Dashboard.</p>
          </EmptyState>
        )
      ) : (
        <>
          <RoundCards rounds={open} meIsAdmin={me.role === 'admin'} label="Open rounds" hideHeading={!closed.length} />
          {closed.length > 0 && <RoundCards rounds={closed} meIsAdmin={me.role === 'admin'} label="Closed rounds" />}
        </>
      )}
      <NewRoundDialog open={creating} onClose={() => setCreating(false)} />
    </>
  );
}

function RoundCards({ rounds, label, hideHeading, meIsAdmin }: { rounds: RoundSummary[]; label: string; hideHeading?: boolean; meIsAdmin: boolean }) {
  if (!rounds.length) return null;
  const id = label.toLowerCase().replace(/\s+/g, '-');
  return (
    <section aria-labelledby={id} className="rounds-section">
      <h2 id={id} className={hideHeading ? 'visually-hidden' : 'rounds-section__title'}>
        {label}
      </h2>
      <ul className="round-cards" role="list">
        {rounds.map((r) => {
          const c = r.counts;
          const team = r.team.map((m) => m.name);
          return (
            <li key={r.id} className="card round-card" data-testid="round-card">
              <div className="round-card__main">
                <p className="round-card__name">
                  <Link to={`/rounds/${r.id}`}>{r.name}</Link>
                  {r.state === 'closed' && (
                    <Badge tone="neutral" icon="lock">
                      Closed
                    </Badge>
                  )}
                </p>
                <p className="round-card__meta">
                  {r.trackName}
                  {r.requisitionId && <> · {r.requisitionId}</>}
                  {' · '}
                  {r.myRole ? `You: ${ROUND_ROLE_LABELS[r.myRole].toLowerCase()}` : meIsAdmin ? 'You are not on its team (administrator)' : ''}
                </p>
                <p className="round-card__team small muted">
                  Team: {team.length > 5 ? `${team.slice(0, 4).join(', ')} and ${team.length - 4} more` : namesList(team)}
                </p>
              </div>
              <p className="round-card__counts small" aria-label={`${c.upcoming} upcoming, ${c.inProgress} in progress, ${c.waiting} waiting for judgements, ${c.finished} finished`}>
                <span>
                  <strong className="tabular">{c.upcoming}</strong> upcoming
                </span>
                <span>
                  <strong className="tabular">{c.inProgress}</strong> in progress
                </span>
                <span>
                  <strong className="tabular">{c.waiting}</strong> waiting for judgements
                </span>
                <span>
                  <strong className="tabular">{c.finished}</strong> finished
                </span>
              </p>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/** ROUND-1: kept short: a name, the role and an optional requisition id. The creator organises it. */
export function NewRoundDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const tracks = useTracks();
  const navigate = useNavigate();
  const [name, setName] = useState('');
  const [trackId, setTrackId] = useState('');
  const [req, setReq] = useState('');
  const [attempted, setAttempted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (open) {
      setName('');
      setReq('');
      setAttempted(false);
      setError(null);
    }
  }, [open]);
  const role = trackId || tracks?.[0]?.id || '';
  const nameError = !name.trim() ? 'Give the round a name.' : null;
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setAttempted(true);
    if (nameError || !role) return;
    setBusy(true);
    setError(null);
    try {
      const id = await createRound({ name: name.trim(), trackId: role, requisitionId: req.trim() || null });
      onClose();
      navigate(`/rounds/${id}`, { state: { created: true } });
    } catch (err) {
      setError(err instanceof RepoError ? err.message : 'The round could not be created.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="New round"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" type="submit" form="new-round" disabled={busy}>
            Create round
          </Button>
        </>
      }
    >
      <form id="new-round" className="stack" onSubmit={submit} noValidate>
        <Field label="Name" required hint="For example “Web engineers, spring 2027”." error={attempted ? nameError : null}>
          <TextInput value={name} maxLength={MAX_ROUND_NAME} onChange={(e) => setName(e.target.value)} autoComplete="off" data-autofocus />
        </Field>
        <Field label="Role">
          <Select value={role} onChange={(e) => setTrackId(e.target.value)} options={(tracks ?? []).map((t) => ({ value: t.id, label: t.name }))} />
        </Field>
        <Field label="Requisition id" hint="Optional.">
          <TextInput value={req} maxLength={MAX_REQUISITION} onChange={(e) => setReq(e.target.value)} autoComplete="off" spellCheck={false} />
        </Field>
        <p className="small muted">
          <Icon name="info" /> A balanced question set is drawn for the role straight away. You can change it, add your team and plan interviews next.
        </p>
        {error && (
          <p className="field__error" role="alert">
            {error}
          </p>
        )}
      </form>
    </Dialog>
  );
}
