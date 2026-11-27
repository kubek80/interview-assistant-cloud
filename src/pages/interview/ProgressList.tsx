import { Icon } from '../../ui/Icon';
import { progressCounts, type ProgressItem } from './logic';

interface ProgressListProps {
  items: ProgressItem[];
  currentId: string | null;
  /** LIVE-2: the panel's question, when I am looking at another one on my own. */
  panelId?: string | null;
  onJump: (questionId: string) => void;
}

/**
 * FLOW-20, UX-5: every question as a compact numbered chip that jumps to it. Status is carried by
 * the chip's shape and marks (filled when scored, struck through when skipped, a flag, a note mark)
 * and in full by its accessible name and tooltip, never by colour alone (A11Y-3). The legend is in
 * the shortcuts dialog, so it does not take space on every question.
 */
export function ProgressList({ items, currentId, panelId = null, onJump }: ProgressListProps) {
  const c = progressCounts(items);
  const current = items.find((it) => it.questionId === currentId);
  return (
    <nav className="progress" aria-label="Questions">
      <p className="progress__summary">
        <span className="progress__pos">
          {current ? (
            <>
              Question <strong>{current.position}</strong> of {c.total}
            </>
          ) : (
            <>{c.total} questions</>
          )}
        </span>
        <span className="progress__done">
          · {c.resolved} done
          {c.needsNote > 0 && (
            <span className="progress__warn">
              {' · '}
              <Icon name="note" /> {c.needsNote} need{c.needsNote === 1 ? 's' : ''} a note
            </span>
          )}
        </span>
      </p>
      <ol className="progress__list">
        {items.map((it) => {
          const isCurrent = it.questionId === currentId;
          const isPanel = it.questionId === panelId;
          return (
            <li key={it.questionId}>
              <button
                type="button"
                className={`progress__item progress__item--${it.status}${it.needsNote ? ' progress__item--needs-note' : ''}${it.flagged ? ' progress__item--flagged' : ''}${isPanel ? ' progress__item--panel' : ''}`}
                aria-current={isCurrent ? 'step' : undefined}
                title={`Question ${it.position}: ${it.summary}${isPanel ? ' (the panel is here)' : ''}`}
                onClick={() => onJump(it.questionId)}
              >
                {/* Named by its content, not aria-label, so the name always contains the visible number (WCAG 2.5.3). */}
                <span className="visually-hidden">{`Question ${it.position}: ${it.summary}${isCurrent ? ' (current)' : ''}${isPanel ? ' (the panel is here)' : ''}`}</span>
                <span className="progress__num" aria-hidden="true">
                  {it.position}
                </span>
                {it.flagged && <Icon name="flag" className="progress__mark progress__mark--flag" />}
                {it.needsNote && <Icon name="note" className="progress__mark progress__mark--note" />}
              </button>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

/** The strip's legend, for the shortcuts dialog (shown on demand rather than on every question). */
export function ProgressLegend() {
  return (
    <ul className="progress-legend">
      <li>
        <span className="progress__item progress__item--unanswered progress__item--sample" aria-hidden="true">
          <span className="progress__num">5</span>
        </span>
        Not scored yet
      </li>
      <li>
        <span className="progress__item progress__item--scored progress__item--sample" aria-hidden="true">
          <span className="progress__num">5</span>
        </span>
        Scored
      </li>
      <li>
        <span className="progress__item progress__item--skipped progress__item--sample" aria-hidden="true">
          <span className="progress__num">5</span>
        </span>
        Skipped
      </li>
      <li>
        <span className="progress__item progress__item--unanswered progress__item--flagged progress__item--sample" aria-hidden="true">
          <span className="progress__num">5</span>
          <Icon name="flag" className="progress__mark progress__mark--flag" />
        </span>
        Flagged for the debrief
      </li>
      <li>
        <span className="progress__item progress__item--scored progress__item--needs-note progress__item--sample" aria-hidden="true">
          <span className="progress__num">5</span>
          <Icon name="note" className="progress__mark progress__mark--note" />
        </span>
        Scored 1 or 4 and needs a note
      </li>
      <li>
        <span className="progress__item progress__item--unanswered progress__item--sample" aria-current="step" aria-hidden="true">
          <span className="progress__num">5</span>
        </span>
        The question on screen
      </li>
    </ul>
  );
}
