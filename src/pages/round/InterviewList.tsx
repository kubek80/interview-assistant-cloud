import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import { RepoError, cancelInterview, changeInterview, useMe, useRound } from '../../db';
import type { InterviewSummary } from '../../shared/api';
import { Badge, Button, ConfirmDialog, Dialog, Field, Icon, MenuButton, TextArea, TextInput, buttonClass, useToast, type Tone } from '../../ui';
import { dayLabel, localDay } from '../../domain/team';
import { MAX_PLAN_NOTE, STATUS_LABELS, namesList } from '../../domain/rounds';
import { candidateLabel, groupByDay } from '../dashboard/logic';
import { PanelPicker } from './PanelPicker';

const STATUS_TONE: Record<InterviewSummary['status'], Tone> = { upcoming: 'neutral', 'in-progress': 'info', waiting: 'warning', finished: 'success' };

/**
 * TEAM-2, TEAM-16: interviews grouped by day, soonest first. Each row: time, candidate, (round), the
 * panel, the note, and "Open" (the ready screen); for organisers of the round also Change and Cancel.
 * Long lists show the first `page` rows with "Show all".
 */
export function InterviewList({
  items,
  showRound,
  canPlan,
  page = 15,
  emptyText,
  headingLevel = 3,
  testId = 'upcoming-row',
}: {
  items: InterviewSummary[];
  showRound: boolean;
  /** Whether the signed-in person may change and cancel this interview. */
  canPlan: (i: InterviewSummary) => boolean;
  page?: number;
  emptyText: string;
  headingLevel?: 3 | 4;
  testId?: string;
}) {
  const me = useMe();
  const [all, setAll] = useState(false);
  const [changing, setChanging] = useState<InterviewSummary | null>(null);
  const [cancelling, setCancelling] = useState<InterviewSummary | null>(null);
  const { toast } = useToast();
  const today = localDay(new Date());
  const shown = all ? items : items.slice(0, page);
  const groups = useMemo(() => groupByDay(shown), [shown]);
  const H = `h${headingLevel}` as 'h3';

  if (!items.length) {
    return (
      <p className="dash-empty">
        <Icon name="info" /> {emptyText}
      </p>
    );
  }
  return (
    <>
      <div className="up-days">
        {groups.map((g) => (
          <div key={g.date ?? 'none'} className={`up-day${g.date === today ? ' up-day--today' : ''}`}>
            <div className="up-day__head">
              <H className="up-day__title">
                {dayLabel(g.date, today)}
                <span className="muted small"> · {g.items.length}</span>
              </H>
            </div>
            <ul role="list" className="dash-sessions up-list">
              {g.items.map((i) => {
                const who = candidateLabel(i);
                const planner = canPlan(i) && i.state === 'planned';
                return (
                  <li key={i.id} className="dash-session up-row" data-testid={testId}>
                    <span className="up-row__time tabular">{i.time ?? ''}</span>
                    <div className="dash-session__main">
                      <p className="dash-session__who">
                        <span className="dash-candidate">{who}</span>
                        {i.status !== 'upcoming' && (
                          <Badge tone={STATUS_TONE[i.status]} icon={i.status === 'finished' ? 'check' : 'clock'}>
                            {STATUS_LABELS[i.status]}
                          </Badge>
                        )}
                        {!i.questionSet.isRoundDefault && i.state === 'planned' && (
                          <Badge tone="neutral" icon="info">
                            Different questions
                          </Badge>
                        )}
                      </p>
                      <p className="dash-session__meta small muted">
                        {showRound && <>{i.roundName} · </>}
                        {panelText(i, me?.id)}
                        {i.note && (
                          <>
                            {' '}
                            · <Icon name="note" /> <span className="up-row__note">{i.note}</span>
                          </>
                        )}
                      </p>
                    </div>
                    <div className="dash-session__actions">
                      <Link to={`/interviews/${i.id}`} className={buttonClass(i.onMyPanel && i.state === 'planned' ? 'default' : 'ghost', 'sm')}>
                        <Icon name={i.state === 'planned' ? 'play' : 'doc'} />
                        {i.state === 'planned' ? 'Open' : 'View'}
                        <span className="visually-hidden"> the interview with {who}</span>
                      </Link>
                      {planner && (
                        <MenuButton
                          label="Change"
                          srLabel={` the interview with ${who}`}
                          variant="ghost"
                          size="sm"
                          items={[
                            { label: 'Change date, interviewers or note', icon: 'edit', onSelect: () => setChanging(i) },
                            { label: 'Cancel interview', icon: 'trash', onSelect: () => setCancelling(i) },
                          ]}
                        />
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </div>
      {items.length > page && (
        <Button size="sm" variant="ghost" className="dash-more-btn" aria-expanded={all} onClick={() => setAll(!all)}>
          {all ? 'Show fewer' : `Show all ${items.length}`}
        </Button>
      )}
      <ChangeDialog interview={changing} onClose={() => setChanging(null)} onSaved={() => toast('Saved. Everyone on the round sees the change.', 'success')} />
      <ConfirmDialog
        open={!!cancelling}
        title="Cancel this interview?"
        danger
        confirmLabel="Cancel interview"
        cancelLabel="Keep it"
        onCancel={() => setCancelling(null)}
        onConfirm={async () => {
          try {
            await cancelInterview(cancelling!.id);
            toast(`The interview with ${candidateLabel(cancelling!)} is cancelled.`, 'success');
          } catch (err) {
            toast(err instanceof RepoError ? err.message : 'It could not be cancelled.', 'error');
          }
          setCancelling(null);
        }}
      >
        {cancelling && <p>The interview with {candidateLabel(cancelling)} is removed from the round’s list for everyone. The panel is not told by the app.</p>}
      </ConfirmDialog>
    </>
  );
}

/** "You and Olive Organiser", "You", or "with Ben Ng and Cy Park" when I am not on the panel. */
export function panelText(i: Pick<InterviewSummary, 'panel'>, meId: string | undefined): string {
  const others = i.panel.filter((p) => p.id !== meId).map((p) => p.name);
  if (others.length === i.panel.length) return `with ${namesList(others)}`;
  return others.length ? `You and ${namesList(others)}` : 'You';
}

/** TEAM-2: change the day, time, interviewers and note of a planned interview. */
export function ChangeDialog({ interview, onClose, onSaved }: { interview: Pick<InterviewSummary, 'id' | 'roundId' | 'date' | 'time' | 'note' | 'panel' | 'candidate'> | null; onClose: () => void; onSaved?: () => void }) {
  const round = useRound(interview?.roundId);
  const me = useMe();
  const [date, setDate] = useState('');
  const [time, setTime] = useState('');
  const [panel, setPanel] = useState<string[]>([]);
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!interview) return;
    setDate(interview.date ?? '');
    setTime(interview.time ?? '');
    setPanel(interview.panel.map((p) => p.id));
    setNote(interview.note);
    setError(null);
  }, [interview]);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!panel.length) return setError('Choose at least one interviewer.');
    if (time && !date) return setError('Choose the day as well as the time.');
    setBusy(true);
    try {
      await changeInterview(interview!.id, { date: date || null, time: time || null, panel, note: note.trim() });
      onSaved?.();
      onClose();
    } catch (err) {
      setError(err instanceof RepoError ? err.message : 'It could not be saved.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open={!!interview}
      onClose={onClose}
      title="Change the planned interview"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" type="submit" form="change-form" disabled={busy}>
            Save changes
          </Button>
        </>
      }
    >
      <form id="change-form" className="stack" onSubmit={submit} noValidate>
        {interview && <p className="schedule__intro">{candidateLabel(interview)}. The questions stay the same.</p>}
        <div className="schedule__when">
          <Field label="Date">
            <TextInput type="date" value={date} onChange={(e) => setDate(e.target.value)} data-autofocus />
          </Field>
          <Field label="Time">
            <TextInput type="time" value={time} onChange={(e) => setTime(e.target.value)} />
          </Field>
        </div>
        {round && me && <PanelPicker idPrefix="change" team={round.team} value={panel} onChange={setPanel} meId={me.id} />}
        <Field label="Note for the interviewers">
          <TextArea rows={2} value={note} maxLength={MAX_PLAN_NOTE} onChange={(e) => setNote(e.target.value)} />
        </Field>
        {error && (
          <p className="field__error" role="alert">
            {error}
          </p>
        )}
      </form>
    </Dialog>
  );
}
