import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { RepoError, discardInterview, useAnswers } from '../../db';
import { formatCandidateKey } from '../../domain/plan';
import { elapsedMs } from '../../domain/timer';
import type { InterviewPlan, Session } from '../../domain/types';
import { Badge, Button, ConfirmDialog, Icon, SessionStateBadge, buttonClass, formatDate, formatDateTime, useToast } from '../../ui';
import { formatTime, sessionAction, sessionDate, type DashboardItem } from './logic';
import { Attendance } from '../team/Attendance';
import { formatNames, interviewersLabel } from '../../domain/interviewers';

/**
 * FLOW-34: the most prominent action on the Dashboard when an interview on this device is not
 * finished: continue it. One that has not started yet can be discarded here too (FLOW-8).
 */
export function ContinueCard({ session, plan, trackName, others }: { session: Session; plan: InterviewPlan | undefined; trackName: string; others: number }) {
  const answers = useAnswers(session.id);
  const navigate = useNavigate();
  const { toast } = useToast();
  const [discarding, setDiscarding] = useState(false);
  const done = (answers ?? []).filter((a) => a.skipped || a.score != null).length;
  const total = plan?.questions.length ?? answers?.length ?? 0;
  const key = formatCandidateKey(session.candidate);
  const minutes = Math.floor(elapsedMs(session.timer, Date.now()) / 60000);
  const planned = session.state === 'planned';
  const progress = planned
    ? `${total} questions · not started yet`
    : `${done} of ${total} questions done · ${minutes ? `${minutes} min so far` : `started ${formatTime(session.startedAt)}`}`;
  return (
    <section className="continue" aria-labelledby="continue-title">
      <div className="continue__body">
        <h2 id="continue-title" className="continue__title">
          {planned ? 'Ready to start' : 'Continue your interview'}
        </h2>
        <p className="continue__who">
          <span className="dash-candidate continue__key">{key}</span>
          <SessionStateBadge state={session.state} />
        </p>
        <p className="continue__meta">
          {trackName} · {progress} · with {interviewersLabel(session)}
        </p>
      </div>
      <div className="continue__actions">
        <Link to={`/interview/${session.id}`} className={buttonClass('primary', 'lg')}>
          <Icon name="play" />
          Continue interview<span className="visually-hidden"> with {key}</span>
        </Link>
        <div className="cluster">
          {others > 0 && (
            <a
              href="#dash-sessions"
              className="small"
              onClick={(e) => {
                e.preventDefault();
                document.getElementById('dash-sessions')?.focus();
                document.getElementById('dash-sessions')?.scrollIntoView({ block: 'start' });
              }}
            >
              {others} more unfinished
            </a>
          )}
          {planned && (
            <Button size="sm" variant="ghost" onClick={() => setDiscarding(true)}>
              Discard<span className="visually-hidden"> the interview with {key}</span>
            </Button>
          )}
        </div>
      </div>
      <ConfirmDialog
        open={discarding}
        title="Discard this interview?"
        danger
        confirmLabel="Discard"
        onCancel={() => setDiscarding(false)}
        onConfirm={async () => {
          try {
            const { planId } = await discardInterview(session.id);
            setDiscarding(false);
            navigate(`/setup/${planId}`);
          } catch (err) {
            setDiscarding(false);
            toast(err instanceof RepoError ? err.message : 'The interview could not be discarded.', 'error');
          }
        }}
      >
        <p>The interview with {key} has not started. It is removed, and its set-up opens so you can change it and continue again.</p>
      </ConfirmDialog>
    </section>
  );
}

const PAGE = 10;

/**
 * FLOW-1, TEAM-6, TEAM-16: every interview on this device with its state and one obvious action.
 * Other people's records are folded into the interview they belong to (who has submitted, who is
 * still to come); a record that matches no interview here is listed as from another computer.
 * The one in the "continue" card above is not listed again (`exclude`).
 */
export function RecentInterviews({
  items,
  trackNames,
  exclude,
  filtered,
}: {
  items: DashboardItem[] | undefined;
  trackNames: Map<string, string>;
  exclude?: string;
  filtered?: boolean;
}) {
  const [all, setAll] = useState(false);
  const sorted = useMemo(() => (items ?? []).filter((i) => i.session.id !== exclude), [items, exclude]);
  const shown = all ? sorted : sorted.slice(0, PAGE);
  return (
    <section aria-labelledby="dash-sessions" className="dash-section">
      <div className="dash-section-head">
        <h2 id="dash-sessions" tabIndex={-1}>
          {exclude ? 'Other interviews' : 'Interviews'}
        </h2>
        {sorted.length > 0 && <span className="muted small">{sorted.length}</span>}
      </div>
      {items === undefined ? (
        <p className="muted">Loading…</p>
      ) : sorted.length === 0 ? (
        <p className="dash-empty">
          <Icon name="info" /> {filtered ? 'No interview matches.' : exclude ? 'No other interviews on this device yet.' : 'No interviews yet.'}
        </p>
      ) : (
        <>
          <ul className="dash-sessions" role="list">
            {shown.map((i) => {
              const s = i.session;
              // TEAM-6: an interview planned here for others that they have started submitting: the organiser follows it in the debrief.
              const forOthers = s.origin === 'local' && s.state === 'planned' && (i.status === 'waiting' || i.status === 'finished');
              const action = forOthers ? { label: 'Debrief', to: `/debrief/${s.id}`, icon: 'doc' as const } : sessionAction(s);
              const date = sessionDate(s);
              const imported = i.status === 'other-device';
              return (
                <li key={s.id} className="dash-session" data-testid="interview-row">
                  <div className="dash-session__main">
                    <p className="dash-session__who">
                      <span className="dash-candidate">{i.candidate}</span>
                      {!forOthers && <SessionStateBadge state={s.state} />}
                      {i.status === 'waiting' && (
                        <Badge tone="info" icon="clock">
                          Waiting for others
                        </Badge>
                      )}
                      {imported && (
                        <Badge tone="info" icon="folder">
                          From another computer
                        </Badge>
                      )}
                    </p>
                    <p className="dash-session__meta small muted">
                      {i.plan ? (trackNames.get(i.trackId) ?? i.trackId) : 'Questions missing'} ·{' '}
                      {forOthers && i.planned ? (
                        <>
                          with {formatNames(i.planned.expected)}
                          {i.planned.date ? ` · planned for ${formatDate(`${i.planned.date}T12:00:00`)}` : ''}
                        </>
                      ) : (
                        <>
                          {interviewersLabel(s)} ·{' '}
                          <span title={formatDateTime(date.iso)}>
                            {date.label.toLowerCase()} {formatDate(date.iso)}
                          </span>
                        </>
                      )}
                    </p>
                    {i.attendance && <Attendance data={i.attendance} compact />}
                  </div>
                  <div className="dash-session__actions">
                    <Link to={action.to} className={buttonClass('default', 'sm')}>
                      <Icon name={action.icon} />
                      {action.label}
                      <span className="visually-hidden"> for {i.candidate}</span>
                    </Link>
                    {!forOthers && (action.secondary || (i.others > 0 && !imported)) && (
                      <Link to={`/debrief/${s.id}`} className={buttonClass('ghost', 'sm')}>
                        Debrief
                        <span className="visually-hidden"> for {i.candidate}</span>
                      </Link>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
          {sorted.length > PAGE && (
            <Button size="sm" variant="ghost" className="dash-more-btn" aria-expanded={all} onClick={() => setAll(!all)}>
              {all ? 'Show fewer' : `Show all ${sorted.length} interviews`}
            </Button>
          )}
        </>
      )}
    </section>
  );
}
