import { useMemo, useState } from 'react';
import { Link } from 'react-router';
import { RepoError, cancelPlanned, changePlanned, exportInvitations } from '../../db';
import { Button, ConfirmDialog, Icon, MenuButton, buttonClass, downloadFile, useToast } from '../../ui';
import { formatNames } from '../../domain/interviewers';
import { changedSinceExport, dayLabel, localDay } from '../../domain/team';
import { Attendance } from '../team/Attendance';
import { ScheduleDialog } from '../team/ScheduleDialog';
import { groupByDay, type DashboardItem } from './logic';

const PAGE = 12;

/** TEAM-3: saves one invitation file for these planned interviews. */
export function useExportInvitations() {
  const { toast } = useToast();
  return async (ids: string[]) => {
    try {
      const f = await exportInvitations(ids);
      downloadFile(f.fileName, f.mime, f.text);
      toast(`Invitation file saved with ${f.count} interview${f.count === 1 ? '' : 's'}. Send it to the interviewers.`, 'success');
      return true;
    } catch (err) {
      toast(err instanceof RepoError ? err.message : 'The invitations could not be exported.', 'error');
      return false;
    }
  };
}

/**
 * TEAM-2, TEAM-3, TEAM-6, TEAM-16: interviews planned for later, soonest first and grouped by day.
 * Each row: time, candidate, role, interviewers, who has submitted and who is still to come, and
 * Start (the ready screen), Change, and a menu with Export invitation and Cancel. Rows can be
 * selected to export several invitations in one file; each day can be exported at once.
 */
export function Upcoming({ items, trackNames, filtered, showRole = true }: { items: DashboardItem[]; trackNames: Map<string, string>; filtered: boolean; showRole?: boolean }) {
  const [all, setAll] = useState(false);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [changing, setChanging] = useState<DashboardItem | null>(null);
  const [cancelling, setCancelling] = useState<DashboardItem | null>(null);
  const exportIds = useExportInvitations();
  const { toast } = useToast();
  const today = localDay(new Date());
  const shown = all ? items : items.slice(0, PAGE);
  const groups = useMemo(() => groupByDay(shown), [shown]);
  const ids = new Set(items.map((i) => i.planned!.id));
  const chosen = [...selected].filter((id) => ids.has(id));
  const toggle = (id: string) => setSelected((s) => (s.has(id) ? new Set([...s].filter((x) => x !== id)) : new Set([...s, id])));

  return (
    <section aria-labelledby="dash-upcoming" className="dash-section">
      <div className="dash-section-head">
        <h2 id="dash-upcoming" tabIndex={-1}>
          Upcoming
        </h2>
        <span className="muted small">{items.length === 0 ? '' : `${items.length} planned`}</span>
        <span className="grow" />
        {chosen.length > 0 ? (
          <span className="cluster up-selection" role="group" aria-label="Selected interviews">
            <Button size="sm" variant="primary" icon="download" onClick={async () => (await exportIds(chosen)) && setSelected(new Set())}>
              Export {chosen.length} invitation{chosen.length === 1 ? '' : 's'}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>
              Clear selection
            </Button>
          </span>
        ) : (
          items.length > 1 && (
            <Button size="sm" variant="ghost" icon="download" onClick={() => exportIds(items.map((i) => i.planned!.id))}>
              Export all {filtered ? 'shown' : 'invitations'}
            </Button>
          )
        )}
      </div>
      {items.length === 0 ? (
        <p className="dash-empty">
          <Icon name="info" /> {filtered ? 'No upcoming interview matches.' : 'Nothing planned.'}
        </p>
      ) : (
        <div className="up-days">
          {groups.map((g) => {
            const label = dayLabel(g.date, today);
            const dayIds = items.filter((i) => (i.planned!.date ?? null) === g.date).map((i) => i.planned!.id);
            return (
              <div key={g.date ?? 'none'} className={`up-day${g.date === today ? ' up-day--today' : ''}`}>
                <div className="up-day__head">
                  <h3 className="up-day__title">
                    {label}
                    <span className="muted small"> · {dayIds.length}</span>
                  </h3>
                  {g.date && dayIds.length > 1 && (
                    <Button size="sm" variant="ghost" icon="download" onClick={() => exportIds(dayIds)}>
                      Export this day<span className="visually-hidden">: {label}</span>
                    </Button>
                  )}
                </div>
                <ul role="list" className="dash-sessions up-list">
                  {g.items.map((i) => {
                    const p = i.planned!;
                    const role = trackNames.get(i.trackId) ?? i.trackId;
                    const names = p.expected.length ? formatNames(p.expected) : '';
                    return (
                      <li key={p.id} className="dash-session up-row" data-testid="upcoming-row">
                        <input
                          type="checkbox"
                          className="up-row__check"
                          checked={selected.has(p.id)}
                          onChange={() => toggle(p.id)}
                          aria-label={`Select the interview with ${i.candidate}`}
                        />
                        <span className="up-row__time tabular">{p.time ?? ''}</span>
                        <div className="dash-session__main">
                          <p className="dash-session__who">
                            <span className="dash-candidate">{i.candidate}</span>
                            {changedSinceExport(p) && (
                              <span className="badge badge--warning up-row__changed">
                                <Icon name="alert" /> Changed since the invitation was sent
                              </span>
                            )}
                          </p>
                          <p className="dash-session__meta small muted">
                            {/* The role only when the list mixes roles (it would repeat on every line otherwise). */}
                            {showRole && role}
                            {names && (
                              <>
                                {showRole ? ' · ' : ''}with {names}
                              </>
                            )}
                            {p.source === 'invitation' && <> · from {p.organiser}</>}
                            {p.note && (
                              <>
                                {' '}
                                · <Icon name="note" /> <span className="up-row__note">{p.note}</span>
                              </>
                            )}
                          </p>
                          {i.attendance && <Attendance data={i.attendance} compact />}
                        </div>
                        <div className="dash-session__actions">
                          <Link to={`/interview/${i.session.id}`} className={buttonClass('default', 'sm')}>
                            <Icon name="play" /> Start<span className="visually-hidden"> the interview with {i.candidate}</span>
                          </Link>
                          {(i.attendance?.submitted.length ?? 0) > 0 && (
                            <Link to={`/debrief/${i.session.id}`} className={buttonClass('ghost', 'sm')}>
                              Debrief<span className="visually-hidden"> for {i.candidate}</span>
                            </Link>
                          )}
                          <Button size="sm" variant="ghost" onClick={() => setChanging(i)}>
                            Change<span className="visually-hidden"> the interview with {i.candidate}</span>
                          </Button>
                          <MenuButton
                            label="More"
                            srLabel={` for ${i.candidate}`}
                            icon="chevron-down"
                            variant="ghost"
                            size="sm"
                            items={[
                              { label: 'Export invitation', icon: 'download', onSelect: () => void exportIds([p.id]) },
                              { label: 'Cancel interview', icon: 'trash', onSelect: () => setCancelling(i) },
                            ]}
                          />
                        </div>
                      </li>
                    );
                  })}
                </ul>
              </div>
            );
          })}
        </div>
      )}
      {items.length > PAGE && (
        <Button size="sm" variant="ghost" className="dash-more-btn" aria-expanded={all} onClick={() => setAll(!all)}>
          {all ? 'Show fewer' : `Show all ${items.length} upcoming`}
        </Button>
      )}

      <ScheduleDialog
        open={!!changing}
        title="Change the planned interview"
        submitLabel="Save changes"
        intro={changing ? `${changing.candidate}. The questions stay the same.` : undefined}
        initial={{
          date: changing?.planned?.date ?? '',
          time: changing?.planned?.time ?? '',
          expected: changing?.planned?.expected ?? [],
          note: changing?.planned?.note ?? '',
        }}
        onCancel={() => setChanging(null)}
        onSubmit={async (v) => {
          await changePlanned(changing!.planned!.id, v);
          setChanging(null);
          toast('Saved. Export the invitation again so the others get the change.', 'success');
        }}
      />
      <ConfirmDialog
        open={!!cancelling}
        title="Cancel this interview?"
        danger
        confirmLabel="Cancel interview"
        cancelLabel="Keep it"
        onCancel={() => setCancelling(null)}
        onConfirm={async () => {
          try {
            await cancelPlanned(cancelling!.planned!.id);
            setTimeout(() => document.getElementById('dash-upcoming')?.focus(), 50);
          } catch (err) {
            toast(err instanceof RepoError ? err.message : 'It could not be cancelled.', 'error');
          }
          setCancelling(null);
        }}
      >
        {cancelling && <p>The interview with {cancelling.candidate} is removed from this device. Tell the other interviewers yourself.</p>}
      </ConfirmDialog>
    </section>
  );
}
