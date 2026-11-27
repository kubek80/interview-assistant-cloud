import { useState } from 'react';
import { Icon } from '../../ui/Icon';
import { ItemText } from '../../ui/ItemText';
import { formatSeconds } from '../../ui/format';
import { scoreLabel } from '../../domain/rubric';
import type { LiveState } from '../../shared/api';
import type { Question } from '../../domain/types';
import { firstName, panelSummary, peopleChips, type PanelMark } from './liveModel';

/**
 * LIVE-2, LIVE-3: who is in the interview right now and who leads, in the top bar's second line
 * (where "with …" used to be), so it costs no height. Each person: initials (filled when they have
 * the interview open), first name, and "leads" for the lead. Presence fades by itself after a
 * missed heartbeat. Never colour alone: the state is in the tooltip and the accessible text.
 */
export function PeopleLine({ live, meId, now }: { live: Pick<LiveState, 'panel' | 'leadUserId'>; meId: string; now: number }) {
  const chips = peopleChips(live, meId, now);
  return (
    <ul className="live-bar__people people-line" aria-label="Panel">
      {chips.map((c) => (
        <li key={c.id} className={`person${c.present ? ' person--here' : ''}${c.leading ? ' person--lead' : ''}`} title={`${c.name}${c.isMe ? ' (you)' : ''}: ${c.note}${c.leading ? ', leading' : ''}`} data-testid="person">
          <span className="person__dot" aria-hidden="true">
            {c.initials}
          </span>
          <span className="person__name">{c.isMe ? 'You' : c.name.split(/\s+/)[0]}</span>
          {c.leading && (
            <span className="person__lead">
              <Icon name="lead" />
              leads
            </span>
          )}
          <span className="visually-hidden">: {c.note}</span>
        </li>
      ))}
    </ul>
  );
}

function scoreText(m: PanelMark): string {
  if (m.hidden) return m.resolved ? 'has scored' : 'not yet';
  if (m.skipped) return 'skipped';
  return m.score != null ? `${m.score}` : '—';
}

/**
 * LIVE-3: the other panel members' marks for this question, below my own notes so they never crowd
 * my scoring controls. Folded to one line ("Ben 3 · Cy —"); opened, each person's score, ticks and
 * notes. When the round hides them, only whether each person has scored shows: the server sends
 * nothing more. Updates arrive as they are made without moving my focus (the strip is its own part
 * of the page and never takes focus).
 */
export function PanelStrip({ question, marks, hidden }: { question: Pick<Question, 'id'>; marks: PanelMark[]; hidden: boolean }) {
  const [open, setOpen] = useState(() => {
    try {
      return sessionStorage.getItem('ia.panelStrip') === '1';
    } catch {
      return false;
    }
  });
  const toggle = () => {
    setOpen(!open);
    try {
      if (open) sessionStorage.removeItem('ia.panelStrip');
      else sessionStorage.setItem('ia.panelStrip', '1');
    } catch {
      // Storage unavailable: the choice holds for this page view.
    }
  };
  const id = `panel-strip-${question.id}`;
  return (
    <section className={`panel-strip${open ? ' panel-strip--open' : ''}`} aria-label="The panel on this question" data-testid="panel-strip">
      <div className="panel-strip__head">
        <Icon name="users" />
        <p className="panel-strip__summary">
          <span className="panel-strip__label">Panel:</span>{' '}
          {marks.map((m, i) => (
            <span key={m.recordId} className="panel-strip__person">
              {i > 0 && <span aria-hidden="true"> · </span>}
              {firstName(m.names)} <strong className={m.resolved ? 'panel-strip__score' : 'panel-strip__score panel-strip__score--none'}>{scoreText(m)}</strong>
            </span>
          ))}
          {hidden && <span className="panel-strip__hidden"> · their marks show once you submit yours</span>}
        </p>
        {!hidden && (
          <button type="button" className="link-button panel-strip__toggle" aria-expanded={open} aria-controls={id} onClick={toggle}>
            <Icon name={open ? 'chevron-down' : 'chevron-right'} />
            {open ? 'Hide their marks' : 'Show their marks'}
            <span className="visually-hidden"> ({panelSummary(marks)})</span>
          </button>
        )}
      </div>
      {!hidden && (
        <div id={id} className="panel-strip__body" hidden={!open}>
          {marks.map((m) => (
            <div key={m.recordId} className="panel-strip__card">
              <p className="panel-strip__who">
                <strong>{m.names.join(', ')}</strong>{' '}
                <span className="muted">{m.skipped ? `skipped: ${m.skipReason ?? ''}` : m.score != null ? `scored ${m.score} · ${scoreLabel(m.score)}` : 'not scored yet'}</span>
                {m.probeHandled && <span className="muted"> · handled the probe</span>}
              </p>
              {m.keyPoints.length > 0 && (
                <ul className="panel-strip__ticks" aria-label={`Key points ${firstName(m.names)} ticked`}>
                  {m.keyPoints.map((k, i) => (
                    <li key={i}>
                      <Icon name="check" /> <ItemText text={k} />
                    </li>
                  ))}
                </ul>
              )}
              {m.redFlags.length > 0 && (
                <ul className="panel-strip__ticks panel-strip__ticks--flags" aria-label={`Red flags ${firstName(m.names)} ticked`}>
                  {m.redFlags.map((k, i) => (
                    <li key={i}>
                      <Icon name="alert" /> <ItemText text={k} />
                    </li>
                  ))}
                </ul>
              )}
              {m.notes.length > 0 && (
                <ul className="panel-strip__notes" aria-label={`Notes by ${firstName(m.names)}`}>
                  {m.notes.map((n) => (
                    <li key={n.id}>
                      <span className="mono small muted">[{formatSeconds(n.atSec)}]</span> {n.by && <strong>{n.by}: </strong>}
                      <span className="pre-wrap">{n.text}</span>
                    </li>
                  ))}
                </ul>
              )}
              {!m.keyPoints.length && !m.redFlags.length && !m.notes.length && <p className="small muted">No ticks or notes yet.</p>}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
