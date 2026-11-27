import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { useMyInterviews, useRounds } from '../db';
import type { InterviewSummary, Me, RoundSummary } from '../shared/api';
import { Button, Field, HelpLink, Icon, MenuButton, PageHeader, Select, TextInput, buttonClass, useDocumentTitle } from '../ui';
import { STATUS_LABELS } from '../domain/rounds';
import { localDay, whenLabel } from '../domain/team';
import { NO_FILTER, candidateLabel, dashboardModel, filterInterviews, isFiltered, primaryAction, type DashboardModel, type ListFilter } from './dashboard/logic';
import { InterviewList, panelText } from './round/InterviewList';
import '../styles/pages/setup.css';
import '../styles/pages/dashboard.css';
import '../styles/pages/rounds.css';

/** TEAM-16: the search and filters appear once there are this many interviews (or a filter is set). */
const FILTER_FROM = 8;

/**
 * Route: / (FLOW-1, FLOW-34, ROUND-4, TEAM-2, TEAM-16, UX-9). For the signed-in person: an interview
 * they are in the middle of (the most prominent action), a one-line count, their own upcoming
 * interviews first (grouped by day, soonest first), then the rest of their rounds' upcoming
 * interviews, then started and finished ones. One primary action: "New interview" for an organiser
 * (straight into their round when they organise just one), their next interview for an interviewer.
 */
export default function Dashboard({ me }: { me: Me }) {
  useDocumentTitle('Dashboard');
  const rounds = useRounds({ all: false });
  const items = useMyInterviews(rounds);
  const [filter, setFilter] = useState<ListFilter>(NO_FILTER);
  const [othersOpen, setOthersOpen] = useState(false);
  const model = useMemo(() => (items ? dashboardModel(items, me.id) : undefined), [items, me.id]);
  const filtered = isFiltered(filter);
  const shown = useMemo(() => (model ? { my: filterInterviews(model.myUpcoming, filter), other: filterInterviews(model.otherUpcoming, filter), rest: filterInterviews(model.others, filter) } : undefined), [model, filter]);
  const myRounds = (rounds ?? []).filter((r) => r.myRole);
  const canPlanIn = useMemo(() => new Set(myRounds.filter((r) => r.state === 'open' && r.myRole === 'organiser').map((r) => r.id)), [myRounds]);
  const canCreate = me.permissions.includes('rounds.create');
  // The round's name on each row only when the interviews shown come from more than one round.
  const manyRounds = new Set((items ?? []).map((i) => i.roundId)).size > 1;
  const total = items?.length ?? 0;
  const action = rounds && model ? primaryAction(myRounds, model, canCreate) : null;
  const first = (me.name ?? '').split(/\s+/)[0];

  return (
    <>
      <PageHeader title="Dashboard" subtitle={first ? `Welcome, ${first}.` : undefined} actions={action && !model?.continuing.length ? <PrimaryAction action={action} /> : action ? <PrimaryAction action={action} quiet /> : undefined} />
      {model?.continuing.map((i) => <ContinueCard key={i.id} interview={i} meId={me.id} />)}
      {rounds && items && myRounds.length === 0 ? (
        <Welcome canCreate={canCreate} isAdmin={me.role === 'admin'} />
      ) : model && shown ? (
        <>
          {(total >= FILTER_FROM || filtered) && <Overview model={model} filter={filter} onFilter={setFilter} rounds={myRounds} />}
          <section aria-labelledby="dash-mine" className="dash-section">
            <div className="dash-section-head">
              <h2 id="dash-mine" tabIndex={-1}>
                Your upcoming interviews
              </h2>
              <span className="muted small">{shown.my.length}</span>
            </div>
            <InterviewList
              items={shown.my}
              showRound={manyRounds}
              canPlan={(i) => canPlanIn.has(i.roundId)}
              page={20}
              emptyText={filtered ? 'None of yours matches.' : 'You are not on the panel of any upcoming interview.'}
              testId="my-row"
            />
          </section>
          {(model.otherUpcoming.length > 0 || filtered) && (
            <section aria-labelledby="dash-others" className="dash-section">
              <div className="dash-section-head">
                <h2 id="dash-others">Other upcoming interviews in your rounds</h2>
                {(filtered || canPlanIn.size > 0) && <span className="muted small">{shown.other.length}</span>}
                {/* Others' interviews matter less to an interviewer: folded away unless searching or planning. */}
                {!filtered && !canPlanIn.size && (
                  <Button size="sm" variant="ghost" aria-expanded={othersOpen} aria-controls="dash-others-list" onClick={() => setOthersOpen(!othersOpen)}>
                    {othersOpen ? 'Hide' : `Show ${shown.other.length}`}
                  </Button>
                )}
              </div>
              <div id="dash-others-list" hidden={!filtered && !canPlanIn.size && !othersOpen}>
                <InterviewList items={shown.other} showRound={manyRounds} canPlan={(i) => canPlanIn.has(i.roundId)} page={10} emptyText="None matches." testId="other-upcoming-row" />
              </div>
            </section>
          )}
          {shown.rest.length > 0 && (
            <section aria-labelledby="dash-rest" className="dash-section">
              <div className="dash-section-head">
                <h2 id="dash-rest">Started and finished</h2>
                <span className="muted small">{shown.rest.length}</span>
              </div>
              <InterviewList items={shown.rest} showRound={manyRounds} canPlan={() => false} page={10} emptyText="" testId="other-row" />
            </section>
          )}
          <p className="dash-rounds-link small">
            <Link to="/rounds">Your rounds</Link> · <HelpLink slug="12-planning-and-panels">How planning works</HelpLink>
          </p>
        </>
      ) : (
        <p className="muted">Loading…</p>
      )}
    </>
  );
}

function PrimaryAction({ action, quiet }: { action: ReturnType<typeof primaryAction>; quiet?: boolean }) {
  const navigate = useNavigate();
  const v = quiet ? 'default' : 'primary';
  switch (action.kind) {
    case 'new-in-round':
      return (
        <>
          <Link to={`/rounds/${action.round.id}/plan`} className={buttonClass('ghost')}>
            <Icon name="folder" /> Plan several
          </Link>
          <Link to={`/rounds/${action.round.id}/new`} className={buttonClass(v, quiet ? 'md' : 'lg')} data-testid="new-interview">
            <Icon name="plus" /> New interview <span className="visually-hidden">in {action.round.name}</span>
          </Link>
        </>
      );
    case 'choose-round':
      return <MenuButton label="New interview" icon="plus" variant={v} size={quiet ? 'md' : 'lg'} items={action.rounds.map((r) => ({ label: r.name, onSelect: () => navigate(`/rounds/${r.id}/new`) }))} />;
    case 'create-round':
      return (
        <Link to="/rounds?create=1" className={buttonClass(v, quiet ? 'md' : 'lg')}>
          <Icon name="plus" /> New round
        </Link>
      );
    case 'next-interview':
      return (
        <Link to={`/interviews/${action.interview.id}`} className={buttonClass(v, quiet ? 'md' : 'lg', 'dash-next')} data-testid="next-interview">
          <Icon name="play" /> Your next interview: {candidateLabel(action.interview)}
          {action.interview.date && <>, {whenLabel(action.interview, localDay(new Date()))}</>}
        </Link>
      );
    default:
      return null;
  }
}

/** FLOW-34: an interview I am in the middle of is the most prominent thing on the page. */
function ContinueCard({ interview, meId }: { interview: InterviewSummary; meId: string }) {
  // LIVE-8: someone on the panel who has not joined yet joins it (it is running without them).
  const joined = interview.panel.find((p) => p.id === meId)?.status === 'joined';
  return (
    <section className="continue" aria-labelledby={`continue-${interview.id}`}>
      <div className="continue__body">
        <h2 className="continue__title" id={`continue-${interview.id}`}>
          <Icon name="clock" /> {interview.state === 'paused' ? 'Paused' : 'In progress'}
        </h2>
        <p className="continue__who">
          <strong className="continue__key">{candidateLabel(interview)}</strong>
        </p>
        <p className="continue__meta">
          {interview.roundName} · {panelText(interview, meId)}
        </p>
      </div>
      <div className="continue__actions">
        <Link to={joined ? `/interviews/${interview.id}/live` : `/interviews/${interview.id}`} className={buttonClass('primary', 'lg')}>
          <Icon name="play" /> {joined ? 'Continue the interview' : 'Join the interview'}
        </Link>
      </div>
    </section>
  );
}

/** TEAM-16: a one-line count, search by candidate, and filters by round and state. */
function Overview({ model, filter, onFilter, rounds }: { model: DashboardModel; filter: ListFilter; onFilter: (f: ListFilter) => void; rounds: RoundSummary[] }) {
  const c = model.counts;
  const parts: Array<[keyof typeof STATUS_LABELS, number]> = [
    ['upcoming', c.upcoming],
    ['in-progress', c['in-progress']],
    ['waiting', c.waiting],
    ['finished', c.finished],
  ];
  return (
    <section className="dash-overview" aria-label="Find interviews">
      <p className="dash-counts" data-testid="dash-counts">
        {parts.map(([k, n], i) => (
          <span key={k}>
            {i > 0 && <span aria-hidden="true"> · </span>}
            <strong className="tabular">{n}</strong> {STATUS_LABELS[k].toLowerCase()}
          </span>
        ))}
      </p>
      <div className="dash-filters">
        <Field label="Find a candidate" className="dash-filters__search">
          <TextInput type="search" value={filter.text} onChange={(e) => onFilter({ ...filter, text: e.target.value })} placeholder="Name or initials" autoComplete="off" />
        </Field>
        {rounds.length > 1 && (
          <Field label="Round">
            <Select value={filter.roundId} onChange={(e) => onFilter({ ...filter, roundId: e.target.value })} options={[{ value: '', label: 'All rounds' }, ...rounds.map((r) => ({ value: r.id, label: r.name }))]} />
          </Field>
        )}
        <Field label="State">
          <Select
            value={filter.status}
            onChange={(e) => onFilter({ ...filter, status: e.target.value as ListFilter['status'] })}
            options={[{ value: '', label: 'All' }, ...parts.map(([k]) => ({ value: k, label: STATUS_LABELS[k] }))]}
          />
        </Field>
        {isFiltered(filter) && (
          <Button size="sm" variant="ghost" icon="x" className="dash-filters__clear" onClick={() => onFilter(NO_FILTER)}>
            Clear
          </Button>
        )}
      </div>
    </section>
  );
}

/** Not on any round yet: what to do next, in one line, and the one thing to do. */
function Welcome({ canCreate, isAdmin }: { canCreate: boolean; isAdmin: boolean }) {
  return (
    <section className="card dash-welcome" aria-labelledby="dash-welcome-title">
      <h2 id="dash-welcome-title">{canCreate ? 'Start a hiring round' : 'You are not on a round yet'}</h2>
      {canCreate ? (
        <>
          <p>A round is one role you are hiring for, with its own team and questions. Create one, add your team, and plan its interviews one at a time or by pasting a list.</p>
          <div className="cluster-lg">
            <Link to="/rounds?create=1" className={buttonClass('primary', 'lg')}>
              <Icon name="plus" /> New round
            </Link>
            {isAdmin && <Link to="/rounds">See every round</Link>}
            <HelpLink slug="12-planning-and-panels">How it works</HelpLink>
          </div>
        </>
      ) : (
        <p>When an organiser puts you on a round’s team, its interviews appear here, yours first.</p>
      )}
    </section>
  );
}
