import { useMemo, useState, type FormEvent } from 'react';
import { Link, NavLink, Navigate, useLocation, useParams } from 'react-router';
import {
  RepoError,
  closeRound,
  removeRoundMember,
  reopenRound,
  setRoundMember,
  updateRound,
  useRound,
  useRoundAudit,
  useRoundInterviews,
  useRoundQuestionSet,
  useTeamOptions,
  AUDIT_ACTION_LABELS,
} from '../../db';
import { ROUND_ROLE_LABELS, type Me, type RoundDetail, type RoundRole } from '../../shared/api';
import { Alert, Badge, Button, Checkbox, ConfirmDialog, EmptyState, Field, Icon, IconButton, PageHeader, ReasonDialog, Select, TextInput, buttonClass, formatDate, formatDateTime, useDocumentTitle, useToast } from '../../ui';
import { MAX_REQUISITION, MAX_ROUND_NAME, STATUS_LABELS } from '../../domain/rounds';
import { NO_FILTER, filterInterviews, isFiltered, type ListFilter } from '../dashboard/logic';
import { InterviewList } from './InterviewList';
import { QuestionsSection } from './QuestionsSection';
import '../../styles/pages/dashboard.css';
import '../../styles/pages/team.css';
import '../../styles/pages/rounds.css';

const SECTIONS = ['interviews', 'team', 'questions', 'settings'] as const;
type Section = (typeof SECTIONS)[number];

/**
 * Route: /rounds/:roundId/:section (ROUND-1…ROUND-5). One round: its interviews, team, question set
 * and settings, each a section with its own address. The primary action is "New interview" (with
 * "Plan several" beside it) for the round's organisers while it is open.
 */
export default function RoundPage({ me }: { me: Me }) {
  const { roundId, section } = useParams();
  const round = useRound(roundId);
  const location = useLocation();
  useDocumentTitle(round?.name ?? 'Round');
  if (!SECTIONS.includes((section ?? 'interviews') as Section)) return <Navigate to={`/rounds/${roundId}`} replace />;
  if (round === undefined) return <PageHeader title="Round" />;
  if (round === null) {
    return (
      <>
        <PageHeader title="Round not found" />
        <EmptyState title="This round does not exist, or you are not on its team.">
          <p>
            <Link to="/rounds">See your rounds</Link>
          </p>
        </EmptyState>
      </>
    );
  }
  const current = (section ?? 'interviews') as Section;
  const created = (location.state as { created?: boolean } | null)?.created;
  const showSettings = round.canManage;
  const tabs: Array<{ id: Section; label: string; count?: number }> = [
    { id: 'interviews', label: 'Interviews', count: round.counts.upcoming + round.counts.inProgress + round.counts.waiting + round.counts.finished },
    { id: 'team', label: 'Team', count: round.team.length },
    { id: 'questions', label: 'Questions' },
    ...(showSettings ? [{ id: 'settings' as const, label: 'Settings' }] : []),
  ];

  return (
    <>
      <PageHeader
        title={round.name}
        subtitle={
          <>
            {round.trackName}
            {round.requisitionId && <> · {round.requisitionId}</>}
            {round.myRole && <> · you are {round.myRole === 'organiser' ? 'an organiser' : 'an interviewer'}</>}{' '}
            {round.state === 'closed' && (
              <Badge tone="neutral" icon="lock">
                Closed
              </Badge>
            )}
          </>
        }
        actions={
          round.canPlan ? (
            <>
              <Link to={`/rounds/${round.id}/plan`} className={buttonClass('ghost')}>
                <Icon name="folder" /> Plan several
              </Link>
              <Link to={`/rounds/${round.id}/new`} className={buttonClass('primary')} data-testid="new-interview">
                <Icon name="plus" /> New interview
              </Link>
            </>
          ) : undefined
        }
      />
      {created && (
        <Alert tone="success" title="Round created. Its questions are drawn and ready." role="status">
          <p>
            Next: <Link to={`/rounds/${round.id}/team`}>add your team</Link>, then plan interviews. You can <Link to={`/rounds/${round.id}/questions`}>look at or change the questions</Link> first.
          </p>
        </Alert>
      )}
      {round.state === 'closed' && <ClosedNotice round={round} />}
      <nav className="round-tabs" aria-label="Round sections">
        <ul role="list">
          {tabs.map((t) => (
            <li key={t.id}>
              <NavLink to={`/rounds/${round.id}${t.id === 'interviews' ? '' : `/${t.id}`}`} end className={() => `round-tabs__tab${current === t.id ? ' round-tabs__tab--current' : ''}`} aria-current={current === t.id ? 'page' : undefined}>
                {t.label}
                {t.count !== undefined && <span className="round-tabs__count">{t.count}</span>}
              </NavLink>
            </li>
          ))}
        </ul>
      </nav>
      <div className="round-body">
        {current === 'interviews' && <InterviewsSection round={round} />}
        {current === 'team' && <TeamSection round={round} me={me} />}
        {current === 'questions' && <QuestionsTab round={round} />}
        {current === 'settings' && showSettings && <SettingsSection round={round} />}
        {current === 'settings' && !showSettings && <p className="muted">Only the round’s organisers change its settings.</p>}
      </div>
    </>
  );
}

function ClosedNotice({ round }: { round: RoundDetail }) {
  const [reopening, setReopening] = useState(false);
  const { toast } = useToast();
  return (
    <Alert tone="info" title={`This round was closed on ${formatDate(round.closedAt)}. It is read-only.`}>
      {round.closeReason && <p>Reason: {round.closeReason}</p>}
      {round.canManage && (
        <p>
          <Button size="sm" onClick={() => setReopening(true)}>
            Reopen the round
          </Button>
        </p>
      )}
      <ReasonDialog
        open={reopening}
        title="Reopen this round?"
        label="Why is it reopened?"
        submitLabel="Reopen"
        onCancel={() => setReopening(false)}
        onSubmit={async (reason) => {
          try {
            await reopenRound(round.id, reason);
            setReopening(false);
            toast('The round is open again.', 'success');
          } catch (err) {
            toast(err instanceof RepoError ? err.message : 'It could not be reopened.', 'error');
          }
        }}
      >
        <p>Its organisers can plan and change interviews again. This is recorded in the audit log.</p>
      </ReasonDialog>
    </Alert>
  );
}

/** ROUND-4, TEAM-2, TEAM-16: the round's interviews, upcoming grouped by day, then the others. */
function InterviewsSection({ round }: { round: RoundDetail }) {
  const items = useRoundInterviews(round.id);
  const [filter, setFilter] = useState<ListFilter>(NO_FILTER);
  const shown = useMemo(() => filterInterviews(items ?? [], filter), [items, filter]);
  if (items === undefined) return <p className="muted">Loading…</p>;
  if (items === null) return null;
  const upcoming = shown.filter((i) => i.status === 'upcoming');
  const others = shown.filter((i) => i.status !== 'upcoming');
  const c = round.counts;
  if (!items.length) {
    return (
      <section className="card dash-welcome" aria-labelledby="round-empty">
        <h2 id="round-empty">No interviews planned yet</h2>
        {round.canPlan ? (
          <>
            <p>
              The round’s questions are ready ({' '}
              <Link to={`/rounds/${round.id}/questions`}>look at them</Link>). Plan one interview, or paste a list of candidates to plan many at once.
              {round.team.length < 2 && (
                <>
                  {' '}
                  Add the <Link to={`/rounds/${round.id}/team`}>team</Link> first if others will interview.
                </>
              )}
            </p>
            <div className="cluster-lg">
              <Link to={`/rounds/${round.id}/new`} className={buttonClass('primary', 'lg')}>
                <Icon name="plus" /> New interview
              </Link>
              <Link to={`/rounds/${round.id}/plan`}>Plan several at once</Link>
            </div>
          </>
        ) : (
          <p>The round’s organisers plan its interviews. They appear here and on your Dashboard.</p>
        )}
      </section>
    );
  }
  return (
    <>
      <section className="dash-overview" aria-label="Find interviews">
        <p className="dash-counts" data-testid="round-counts">
          <span>
            <strong className="tabular">{c.upcoming}</strong> upcoming
          </span>
          <span aria-hidden="true"> · </span>
          <span>
            <strong className="tabular">{c.inProgress}</strong> in progress
          </span>
          <span aria-hidden="true"> · </span>
          <span>
            <strong className="tabular">{c.waiting}</strong> waiting for judgements
          </span>
          <span aria-hidden="true"> · </span>
          <span>
            <strong className="tabular">{c.finished}</strong> finished
          </span>
        </p>
        {items.length >= 8 && (
          <div className="dash-filters">
            <Field label="Find a candidate" className="dash-filters__search">
              <TextInput type="search" value={filter.text} onChange={(e) => setFilter({ ...filter, text: e.target.value })} placeholder="Name or initials" autoComplete="off" />
            </Field>
            <Field label="State">
              <Select
                value={filter.status}
                onChange={(e) => setFilter({ ...filter, status: e.target.value as ListFilter['status'] })}
                options={[{ value: '', label: 'All' }, ...(Object.keys(STATUS_LABELS) as Array<keyof typeof STATUS_LABELS>).map((k) => ({ value: k, label: STATUS_LABELS[k] }))]}
              />
            </Field>
            {isFiltered(filter) && (
              <Button size="sm" variant="ghost" icon="x" className="dash-filters__clear" onClick={() => setFilter(NO_FILTER)}>
                Clear
              </Button>
            )}
          </div>
        )}
      </section>
      <section aria-labelledby="round-upcoming" className="dash-section">
        <div className="dash-section-head">
          <h2 id="round-upcoming" tabIndex={-1}>
            Upcoming
          </h2>
          <span className="muted small">{upcoming.length} planned</span>
        </div>
        <InterviewList items={upcoming} showRound={false} canPlan={() => round.canPlan} page={30} emptyText={isFiltered(filter) ? 'No upcoming interview matches.' : 'Nothing planned.'} />
      </section>
      {others.length > 0 && (
        <section aria-labelledby="round-others" className="dash-section">
          <div className="dash-section-head">
            <h2 id="round-others">Started and finished</h2>
          </div>
          <InterviewList items={others} showRound={false} canPlan={() => false} emptyText="" testId="other-row" />
        </section>
      )}
    </>
  );
}

/** ROUND-2: the team: who organises the round and who interviews in it. */
function TeamSection({ round, me }: { round: RoundDetail; me: Me }) {
  const options = useTeamOptions(round.id, round.canManage && round.state === 'open');
  const { toast } = useToast();
  const [userId, setUserId] = useState('');
  const [role, setRole] = useState<RoundRole>('interviewer');
  const [removing, setRemoving] = useState<{ id: string; name: string } | null>(null);
  const manage = round.canManage && round.state === 'open';
  const onTeam = new Set(round.team.map((m) => m.id));
  const candidates = (options ?? []).filter((o) => !onTeam.has(o.id));
  const chosen = candidates.find((o) => o.id === userId);
  const organisers = round.team.filter((m) => m.role === 'organiser').length;
  const act = async (fn: () => Promise<unknown>, done: string) => {
    try {
      await fn();
      toast(done, 'success');
    } catch (err) {
      toast(err instanceof RepoError ? err.message : 'That did not work. Try again.', 'error');
    }
  };
  const add = async (e: FormEvent) => {
    e.preventDefault();
    if (!chosen) return;
    await act(() => setRoundMember(round.id, chosen.id, chosen.canOrganise ? role : 'interviewer'), `${chosen.name} added to the team.`);
    setUserId('');
    setRole('interviewer');
  };
  return (
    <div className="stack">
      <p className="small muted">Organisers plan the round’s interviews and change its questions, team and settings. Interviewers see the round and take part in its interviews.</p>
      <div className="table-wrap">
        <table className="table team-table pc-rtable">
          <caption className="visually-hidden">The round’s team</caption>
          <thead>
            <tr>
              <th scope="col">Name</th>
              <th scope="col">Email</th>
              <th scope="col">In this round</th>
              {manage && (
                <th scope="col">
                  <span className="visually-hidden">Remove</span>
                </th>
              )}
            </tr>
          </thead>
          <tbody>
            {round.team.map((m) => {
              const lastOrganiser = m.role === 'organiser' && organisers <= 1;
              const canOrganise = m.globalRole === 'admin' || m.globalRole === 'organiser';
              return (
                <tr key={m.id}>
                  <th scope="row" data-label="Name">
                    {m.name}
                    {m.id === me.id && <span className="muted"> (you)</span>}
                    {!m.active && (
                      <>
                        {' '}
                        <Badge tone="neutral">Deactivated</Badge>
                      </>
                    )}
                  </th>
                  <td data-label="Email" className="small">
                    {m.email}
                  </td>
                  <td data-label="In this round">
                    {manage && canOrganise && !lastOrganiser ? (
                      <Select
                        aria-label={`Role of ${m.name} in this round`}
                        value={m.role}
                        onChange={(e) => void act(() => setRoundMember(round.id, m.id, e.target.value as RoundRole), `${m.name} is now ${e.target.value === 'organiser' ? 'an organiser' : 'an interviewer'} in this round.`)}
                        options={[
                          { value: 'organiser', label: ROUND_ROLE_LABELS.organiser },
                          { value: 'interviewer', label: ROUND_ROLE_LABELS.interviewer },
                        ]}
                      />
                    ) : (
                      ROUND_ROLE_LABELS[m.role]
                    )}
                  </td>
                  {manage && (
                    <td className="num">
                      {!lastOrganiser && <IconButton icon="trash" size="sm" label={`Remove ${m.name} from the team`} onClick={() => setRemoving({ id: m.id, name: m.name })} />}
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {manage && (
        <form className="card team-add" onSubmit={add} aria-labelledby="team-add-title">
          <h2 id="team-add-title" className="team-add__title">
            Add someone to the team
          </h2>
          <div className="team-add__row">
            <Field label="Person" hint={options && !candidates.length ? 'Everyone with access is on the team already.' : undefined}>
              <Select
                id="team-person"
                value={userId}
                onChange={(e) => setUserId(e.target.value)}
                placeholder="Choose a person"
                options={candidates.map((o) => ({ value: o.id, label: `${o.name} (${o.email})` }))}
              />
            </Field>
            <Field label="In this round" hint={chosen && !chosen.canOrganise ? 'Interviewers in the organisation can only interview.' : undefined}>
              <Select
                id="team-role"
                value={chosen && !chosen.canOrganise ? 'interviewer' : role}
                disabled={!!chosen && !chosen.canOrganise}
                onChange={(e) => setRole(e.target.value as RoundRole)}
                options={[
                  { value: 'interviewer', label: ROUND_ROLE_LABELS.interviewer },
                  { value: 'organiser', label: ROUND_ROLE_LABELS.organiser },
                ]}
              />
            </Field>
            <Button type="submit" variant="primary" icon="plus" disabled={!chosen}>
              Add to team
            </Button>
          </div>
          <p className="small muted">Only people with access are listed; an administrator adds new people on the Users page. Question reviewers cannot be on a round.</p>
        </form>
      )}
      <ConfirmDialog
        open={!!removing}
        title="Remove from the team?"
        confirmLabel="Remove"
        danger
        onCancel={() => setRemoving(null)}
        onConfirm={async () => {
          const r = removing!;
          setRemoving(null);
          await act(() => removeRoundMember(round.id, r.id), `${r.name} removed from the team.`);
        }}
      >
        {removing && <p>{removing.name} will no longer see this round or its interviews.</p>}
      </ConfirmDialog>
    </div>
  );
}

function QuestionsTab({ round }: { round: RoundDetail }) {
  const set = useRoundQuestionSet(round.id);
  if (set === undefined) return <p className="muted">Loading…</p>;
  if (!set) return null;
  return <QuestionsSection key={set.id} round={round} set={set} />;
}

/** ROUND-1, ROUND-5, LIVE-3, HPRIV-4: name, requisition, retention, hiding scores, closing, history. */
function SettingsSection({ round }: { round: RoundDetail }) {
  const { toast } = useToast();
  const audit = useRoundAudit(round.id);
  const [name, setName] = useState(round.name);
  const [req, setReq] = useState(round.requisitionId ?? '');
  const [retention, setRetention] = useState(round.retentionUntil);
  const [hide, setHide] = useState(round.hideOthersScores);
  const [closing, setClosing] = useState(false);
  const [busy, setBusy] = useState(false);
  const closed = round.state === 'closed';
  const dirty = name !== round.name || req !== (round.requisitionId ?? '') || retention !== round.retentionUntil || hide !== round.hideOthersScores;
  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return toast('Give the round a name.', 'error');
    setBusy(true);
    try {
      await updateRound(round.id, { name: name.trim(), requisitionId: req.trim() || null, retentionUntil: retention, hideOthersScores: hide });
      toast('Settings saved.', 'success');
    } catch (err) {
      toast(err instanceof RepoError ? err.message : 'The settings could not be saved.', 'error');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="stack-lg">
      <form className="card stack round-settings" onSubmit={save} aria-label="Round settings">
        <fieldset disabled={closed} className="stack">
          <div className="ni-grid">
            <Field label="Name">
              <TextInput id="rs-name" value={name} maxLength={MAX_ROUND_NAME} onChange={(e) => setName(e.target.value)} />
            </Field>
            <Field label="Requisition id" hint="Optional.">
              <TextInput id="rs-req" value={req} maxLength={MAX_REQUISITION} onChange={(e) => setReq(e.target.value)} spellCheck={false} />
            </Field>
            <Field label="Keep the round’s records until" hint="Its interviews are deleted after this day. The default comes from the organisation’s settings.">
              <TextInput id="rs-retention" type="date" value={retention} onChange={(e) => setRetention(e.target.value)} />
            </Field>
          </div>
          <Checkbox
            id="rs-hide"
            checked={hide}
            onChange={(e) => setHide(e.target.checked)}
            label="Hide other people’s scores until you have submitted yours"
            description="Each interviewer then scores independently, without seeing colleagues’ scores first."
          />
          <div>
            <Button type="submit" variant="primary" disabled={!dirty || busy}>
              Save settings
            </Button>
          </div>
        </fieldset>
      </form>

      <section className="card stack" aria-labelledby="rs-close">
        <h2 id="rs-close">{closed ? 'Reopen the round' : 'Close the round'}</h2>
        <p className="small muted">{closed ? 'Reopening lets its organisers plan and change interviews again.' : 'A closed round is read-only: no new interviews and no changes. It can be reopened.'}</p>
        <div>{closed ? <ClosedNotice round={round} /> : <Button onClick={() => setClosing(true)}>Close the round…</Button>}</div>
      </section>

      <section aria-labelledby="rs-history" className="stack-sm">
        <h2 id="rs-history">Recent changes</h2>
        {audit === undefined ? (
          <p className="muted">Loading…</p>
        ) : (
          <ul className="round-history" role="list">
            {audit.slice(0, 15).map((e) => (
              <li key={e.id}>
                <span className="small muted tabular">{formatDateTime(e.at)}</span> <strong>{AUDIT_ACTION_LABELS[e.action] ?? e.action}</strong> <span className="small muted">by {e.actor.replace(/ <.*>$/, '')}</span>
                {e.reason && <span className="small"> · “{e.reason}”</span>}
              </li>
            ))}
          </ul>
        )}
      </section>
      <ReasonDialog
        open={closing}
        title="Close this round?"
        optional
        label="Reason (optional)"
        submitLabel="Close round"
        onCancel={() => setClosing(false)}
        onSubmit={async (reason) => {
          try {
            await closeRound(round.id, reason);
            setClosing(false);
            toast('The round is closed.', 'success');
          } catch (err) {
            toast(err instanceof RepoError ? err.message : 'It could not be closed.', 'error');
          }
        }}
      >
        <p>Nobody can plan or change interviews in it until it is reopened.</p>
      </ReasonDialog>
    </div>
  );
}
