import { useEffect, useRef } from 'react';
import { Icon, type IconName } from '../../ui/Icon';
import { useToast } from '../../ui/Toast';
import { formatDuration, formatDurationLong, formatMinutes } from '../../ui/format';
import { TIMER_STATUS_LABEL, type TimerStatus } from '../../domain/timer';
import { timerChangeAnnouncement, type TimerSnapshot } from './logic';

const STATUS_ICON: Record<TimerStatus, IconName> = { normal: 'clock', amber: 'alert', red: 'alert' };

interface TimerProps {
  label: string;
  elapsedMs: number;
  /** Budget or estimate in minutes. */
  limitMin: number;
  status: TimerStatus;
  paused: boolean;
  /** Status text for this timer kind; defaults to the shared labels. */
  statusText?: string;
  compact?: boolean;
  /**
   * In a bar: no box, the label small above the digits, and the status shown in words only when it
   * needs attention (amber, red, paused); otherwise it is read by screen readers only.
   */
  inline?: boolean;
}

/**
 * FLOW-19, RES-2, A11Y-3/4: a timer derived from stored timestamps. State is shown with text and an
 * icon as well as colour. The digits are `role="timer"` (aria-live off), so the ticking is never
 * announced; state changes are announced once by `useTimerAnnouncements`.
 */
export function TimerDisplay({ label, elapsedMs, limitMin, status, paused, statusText, compact, inline }: TimerProps) {
  const tone = paused ? 'paused' : status;
  const quiet = inline && !paused && status === 'normal';
  return (
    <div className={`timer timer--${tone}${compact ? ' timer--compact' : ''}${inline ? ' timer--inline' : ''}`}>
      <span className="timer__label">{label}</span>
      <span className="timer__time">
        <span role="timer" aria-live="off" aria-label={`${label}: ${formatDurationLong(elapsedMs)}`} className="timer__digits tabular">
          {formatDuration(elapsedMs)}
        </span>
        <span className="timer__limit tabular" aria-hidden="true">
          {' / '}
          {formatDuration(limitMin * 60_000)}
        </span>
        <span className="visually-hidden"> of {formatMinutes(limitMin)}</span>
      </span>
      <span className={`timer__status${quiet ? ' visually-hidden' : ''}`}>
        <Icon name={paused ? 'pause' : STATUS_ICON[status]} />
        <span className="timer__status-text">{paused ? 'Paused' : (statusText ?? TIMER_STATUS_LABEL[status])}</span>
      </span>
    </div>
  );
}

/** A11Y-4: announce a timer turning amber or red once, through the shared live region. */
export function useTimerAnnouncements(snapshot: TimerSnapshot | null) {
  const { announce } = useToast();
  const prev = useRef<TimerSnapshot | null>(null);
  const key = snapshot ? `${snapshot.questionId}|${snapshot.overall}|${snapshot.question}|${snapshot.paused}` : '';
  useEffect(() => {
    if (!snapshot) return;
    const msg = timerChangeAnnouncement(prev.current, snapshot);
    prev.current = snapshot;
    if (msg) announce(msg);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `key` captures the snapshot's content
  }, [key]);
}
