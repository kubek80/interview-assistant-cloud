import { useMemo, useState } from 'react';
import { Link } from 'react-router';
import { RepoError, deletePlanDraft, useCandidateDrafts, usePlannedInterviews, usePlans, useSessions, useTracks } from '../db';
import type { InterviewPlan, Session, Track } from '../domain/types';
import { Button, ConfirmDialog, Field, HelpLink, Icon, PageHeader, Select, TextInput, buttonClass, formatDate, useDocumentTitle, useToast } from '../ui';
import { clearLegacyCandidateDraft } from './setup/candidateDraft';
import {
  NO_FILTER,
  STATUS_LABELS,
  dashboardModel,
  filterItems,
  isFiltered,
  sessionCounts,
  splitPlans,
  unfinishedSessions,
  type DashboardFilter,
  type DashboardModel,
  type InterviewStatus,
} from './dashboard/logic';
import { useExportPlan } from './dashboard/planFiles';
import { ContinueCard, RecentInterviews } from './dashboard/Sessions';
import { Upcoming } from './dashboard/Upcoming';
import { useImportFiles } from './team/ImportFiles';
import '../styles/pages/setup.css';
import '../styles/pages/dashboard.css';

/** TEAM-16: the search and filters appear once there are this many interviews (or a filter is set). */
const FILTER_FROM = 8;

/**
 * Route: / (FLOW-1, FLOW-9, FLOW-34, UX-9, TEAM-2, TEAM-16). Glanceable: the unfinished interview to
 * continue (the most prominent action), a one-line count, Upcoming grouped by day, the other
 * interviews with who has submitted, then a quiet area for question sets, set-ups and the bank.
 * "Import files" takes any of the app's files (invitations, interview files, question sets).
 */
export default function Dashboard() {
  useDocumentTitle('Dashboard');
  const tracks = useTracks();
  const sessions = useSessions();
  const plans = usePlans();
  const planned = usePlannedInterviews();
  const importer = useImportFiles();
  const [filter, setFilter] = useState<DashboardFilter>(NO_FILTER);
  const trackNames = useMemo(() => new Map((tracks ?? []).map((t) => [t.id, t.name])), [tracks]);
  const plansById = useMemo(() => new Map((plans ?? []).map((p) => [p.id, p])), [plans]);
  const model = useMemo(() => (sessions && plans && planned ? dashboardModel(sessions, plans, planned) : undefined), [sessions, plans, planned]);
  const unfinished = useMemo(() => unfinishedSessions(sessions ?? []), [sessions]);
  const current: Session | undefined = unfinished[0];
  const currentPlan = current ? plansById.get(current.planId) : undefined;
  const firstRun = sessions !== undefined && sessions.length === 0;
  const filtered = isFiltered(filter);
  const upcoming = useMemo(() => filterItems(model?.upcoming ?? [], filter), [model, filter]);
  const interviews = useMemo(() => (model ? filterItems(model.interviews, filter) : undefined), [model, filter]);
  const total = model ? model.upcoming.length + model.interviews.length : 0;

  return (
    <>
      <PageHeader
        title="Dashboard"
        actions={
          <div className="cluster dash-actions">
            {importer.trigger}
            {!firstRun && (
              <>
                <Link to="/plan" className={buttonClass('ghost')}>
                  <Icon name="folder" /> Plan several
                </Link>
                <Link to="/new" className={buttonClass(current ? 'default' : 'primary', current ? 'md' : 'lg')} data-testid="new-interview">
                  <Icon name="plus" /> New interview
                </Link>
              </>
            )}
          </div>
        }
      />
      {importer.results}
      {current && (
        <ContinueCard
          session={current}
          plan={currentPlan}
          trackName={currentPlan ? (trackNames.get(currentPlan.trackId) ?? currentPlan.trackId) : ''}
          others={unfinished.length - 1}
        />
      )}
      {firstRun ? (
        <Welcome />
      ) : (
        <>
          {model && (total >= FILTER_FROM || filtered) && <Overview model={model} filter={filter} onFilter={setFilter} tracks={tracks ?? []} />}
          {model && model.upcoming.length > 0 && (
            <Upcoming items={upcoming} trackNames={trackNames} filtered={filtered} showRole={!filter.trackId && new Set(upcoming.map((i) => i.trackId)).size > 1} />
          )}
          {!(model && model.upcoming.length > 0 && model.interviews.filter((i) => i.session.id !== current?.id).length === 0) && (
            <RecentInterviews items={interviews} trackNames={trackNames} exclude={current?.id} filtered={filtered} />
          )}
        </>
      )}
      <MoreSection plans={plans} sessions={sessions} tracks={tracks} trackNames={trackNames} />
    </>
  );
}

/** TEAM-16: a one-line count, search by candidate, and filters by role, requisition and state. */
function Overview({ model, filter, onFilter, tracks }: { model: DashboardModel; filter: DashboardFilter; onFilter: (f: DashboardFilter) => void; tracks: Track[] }) {
  const c = model.counts;
  const reqs = useMemo(() => [...new Set([...model.upcoming, ...model.interviews].map((i) => i.requisition).filter(Boolean))].sort(), [model]);
  const parts: Array<[InterviewStatus, number]> = [
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
        <Field label="Role">
          <Select value={filter.trackId} onChange={(e) => onFilter({ ...filter, trackId: e.target.value })} options={[{ value: '', label: 'All roles' }, ...tracks.map((t) => ({ value: t.id, label: t.name }))]} />
        </Field>
        {reqs.length > 0 && (
          <Field label="Requisition">
            <Select value={filter.requisition} onChange={(e) => onFilter({ ...filter, requisition: e.target.value })} options={[{ value: '', label: 'All' }, ...reqs.map((r) => ({ value: r, label: r }))]} />
          </Field>
        )}
        <Field label="State">
          <Select
            value={filter.status}
            onChange={(e) => onFilter({ ...filter, status: e.target.value as DashboardFilter['status'] })}
            options={[{ value: '', label: 'All' }, ...(Object.keys(STATUS_LABELS) as InterviewStatus[]).map((k) => ({ value: k, label: STATUS_LABELS[k] }))]}
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

/** First run: what this is, in one line, and the one thing to do. */
function Welcome() {
  return (
    <section className="card dash-welcome" aria-labelledby="dash-welcome-title">
      <h2 id="dash-welcome-title">Run your first structured interview</h2>
      <p>Choose the role and type the candidate’s name or initials: the questions are ready. Read the consent text with the candidate, then start.</p>
      <div className="cluster-lg">
        <Link to="/new" className={buttonClass('primary', 'lg')} data-testid="new-interview">
          <Icon name="plus" /> New interview
        </Link>
        <Link to="/plan">Plan several at once</Link>
        <HelpLink slug="02-interview-flow">How it works</HelpLink>
      </div>
    </section>
  );
}

const SET_PAGE = 4;

/** FLOW-9 question sets (reuse, export, import), unfinished set-ups and the bank: secondary, kept quiet. */
function MoreSection({
  plans,
  sessions,
  tracks,
  trackNames,
}: {
  plans: InterviewPlan[] | undefined;
  sessions: Session[] | undefined;
  tracks: Track[] | undefined;
  trackNames: Map<string, string>;
}) {
  const { drafts, locked } = useMemo(() => splitPlans(plans ?? []), [plans]);
  const counts = useMemo(() => sessionCounts(sessions ?? []), [sessions]);
  const candidateDrafts = useCandidateDrafts();
  const draftWho = useMemo(() => new Map((candidateDrafts ?? []).map((d) => [d.planId, [d.initials, d.requisitionId].filter((x) => x.trim()).join(' · ')])), [candidateDrafts]);
  const [toDelete, setToDelete] = useState<InterviewPlan | null>(null);
  const [allSets, setAllSets] = useState(false);
  const exportPlan = useExportPlan();
  const { toast } = useToast();
  const trackName = (p: InterviewPlan) => trackNames.get(p.trackId) ?? p.trackId;
  const shownSets = allSets ? locked : locked.slice(0, SET_PAGE);

  return (
    <div className="dash-more">
      <section aria-labelledby="dash-sets" className="dash-panel dash-panel--sets">
        <div className="dash-section-head">
          <h2 id="dash-sets" tabIndex={-1}>
            Question sets
          </h2>
        </div>
        {plans === undefined ? (
          <p className="muted">Loading…</p>
        ) : locked.length === 0 ? (
          <p className="dash-empty small">The questions of each interview are kept here, to reuse for another candidate or share with your panel.</p>
        ) : (
          <>
            <ul className="dash-plans" role="list">
              {shownSets.map((p) => (
                <li key={p.id} className="dash-plan">
                  <div className="dash-plan__main">
                    <Link to={`/setup/${p.id}`} className="dash-plan__name">
                      {p.name}
                    </Link>
                    <span className="small muted">
                      {trackName(p)} · {p.questions.length} questions · {counts.get(p.id) ?? 0} interview{counts.get(p.id) === 1 ? '' : 's'}
                    </span>
                  </div>
                  <div className="dash-plan__actions">
                    <Link to={`/new?reuse=${p.id}`} className={buttonClass('default', 'sm')}>
                      <Icon name="plus" /> Reuse<span className="visually-hidden"> for a new interview: {p.name}</span>
                    </Link>
                    <Button size="sm" variant="ghost" icon="download" onClick={() => exportPlan(p.id)}>
                      Export<span className="visually-hidden"> file: {p.name}</span>
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
            {locked.length > SET_PAGE && (
              <Button size="sm" variant="ghost" className="dash-more-btn" aria-expanded={allSets} onClick={() => setAllSets(!allSets)}>
                {allSets ? 'Show fewer' : `Show all ${locked.length}`}
              </Button>
            )}
          </>
        )}
      </section>

      <div className="dash-more__side">
        {drafts.length > 0 && (
          <section aria-labelledby="dash-drafts" className="dash-panel">
            <div className="dash-section-head">
              <h2 id="dash-drafts" tabIndex={-1}>
                Unfinished set-ups
              </h2>
            </div>
            <ul className="dash-drafts" role="list">
              {drafts.map((p) => {
                const who = draftWho.get(p.id);
                return (
                  <li key={p.id} className="dash-draft">
                    <div className="grow">
                      <p className="dash-draft__name">{who ? `For ${who}` : trackName(p)}</p>
                      <p className="small muted">
                        {who ? `${trackName(p)} · ` : ''}
                        {p.questions.length} question{p.questions.length === 1 ? '' : 's'} · {formatDate(p.createdAt)}
                      </p>
                    </div>
                    <div className="cluster">
                      <Link to={`/setup/${p.id}`} className={buttonClass('default', 'sm')}>
                        Continue<span className="visually-hidden"> setting up {who || trackName(p)}</span>
                      </Link>
                      <Button size="sm" variant="ghost" icon="trash" onClick={() => setToDelete(p)}>
                        Delete<span className="visually-hidden"> set-up {who || trackName(p)}</span>
                      </Button>
                    </div>
                  </li>
                );
              })}
            </ul>
          </section>
        )}
        <section aria-labelledby="dash-bank" className="dash-panel">
          <div className="dash-section-head">
            <h2 id="dash-bank">Question bank</h2>
          </div>
          <ul className="dash-banklinks" role="list">
            {(tracks ?? []).map((t) => (
              <li key={t.id}>
                <Link to={`/bank/${t.id}`}>
                  {t.name}
                  <span className="visually-hidden"> questions</span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      </div>

      <ConfirmDialog
        open={!!toDelete}
        title="Delete this set-up?"
        danger
        confirmLabel="Delete set-up"
        onCancel={() => setToDelete(null)}
        onConfirm={async () => {
          if (!toDelete) return;
          try {
            await deletePlanDraft(toDelete.id);
            clearLegacyCandidateDraft(toDelete.id);
            // The row that held the opener is gone: move focus to a stable heading (A11Y-1).
            setTimeout(() => (document.getElementById(drafts.length > 1 ? 'dash-drafts' : 'dash-sets') as HTMLElement | null)?.focus(), 50);
          } catch (err) {
            toast(err instanceof RepoError ? err.message : 'Could not delete the set-up.', 'error');
          }
          setToDelete(null);
        }}
      >
        {toDelete && <p>The set-up and anything typed for its candidate are removed from this device. This cannot be undone.</p>}
      </ConfirmDialog>
    </div>
  );
}
