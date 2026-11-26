import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import { RepoError, exportPanelFile, saveWrittenSummary } from '../../db';
import { Badge, Button, Checkbox, Dialog, Icon, TextArea, downloadFile, formatDateTime, useToast } from '../../ui';
import { formatNames } from '../../domain/interviewers';
import { scoreLabel } from '../../domain/rubric';
import { MAX_SUMMARY } from '../../domain/decision';
import { RECOMMENDATION_LABELS, type PanelDecision, type Recommendation, type WrittenSummary } from '../../domain/types';
import type { IconName } from '../../ui/Icon';
import '../../styles/pages/panel.css';

const REC_ICON: Record<Recommendation, IconName> = { strong_hire: 'check', hire: 'check', lean_no_hire: 'alert', no_hire: 'x' };

/** A recommendation as a pill with an icon and words (A11Y-3: never colour alone). */
export function RecommendationBadge({ value, prefix }: { value: Recommendation; prefix?: string }) {
  return (
    <span className={`badge rec-badge rec-badge--${value}`}>
      <Icon name={REC_ICON[value]} />
      {prefix ? `${prefix} ` : ''}
      {RECOMMENDATION_LABELS[value]}
    </span>
  );
}

/**
 * TEAM-9, TEAM-12: the panel decision, shown as the outcome. It sits next to, never instead of,
 * the individual figures (the caller shows those beside it).
 */
export function DecisionCard({ decision, onChange, headingLevel = 2, title = 'Panel decision' }: { decision: PanelDecision | null; onChange?: () => void; headingLevel?: 2 | 3; title?: string }) {
  const H = `h${headingLevel}` as 'h2' | 'h3';
  if (!decision) {
    return (
      <section className="pd-card pd-card--empty" aria-labelledby="pd-card-h" data-testid="decision-card">
        <H id="pd-card-h" className="pd-card__title">
          {title}
        </H>
        <p className="pd-card__none">No panel decision yet.</p>
        {onChange && (
          <Button variant="primary" icon="check" onClick={onChange}>
            Record panel decision
          </Button>
        )}
      </section>
    );
  }
  return (
    <section className="pd-card" aria-labelledby="pd-card-h" data-testid="decision-card">
      <div className="pd-card__head">
        <H id="pd-card-h" className="pd-card__title">
          {title}
        </H>
        {onChange && (
          <Button size="sm" variant="ghost" icon="edit" onClick={onChange}>
            Change<span className="visually-hidden"> the panel decision</span>
          </Button>
        )}
      </div>
      <p className="pd-card__rec">
        <RecommendationBadge value={decision.recommendation} />
        {decision.rating && <span className="muted small">Agreed rating {decision.rating} · {scoreLabel(decision.rating)}</span>}
        {Object.keys(decision.scores).length > 0 && <Badge tone="neutral">Agreed scores for {Object.keys(decision.scores).length} questions</Badge>}
      </p>
      <p className="pd-card__why pre-wrap">{decision.rationale}</p>
      <p className="small muted pd-card__meta">
        Agreed by {formatNames(decision.participants)}. Recorded by {decision.recordedBy}, {formatDateTime(decision.recordedAt)}
        {decision.changedAt ? `; changed by ${decision.changedBy}, ${formatDateTime(decision.changedAt)}` : ''}.
      </p>
    </section>
  );
}

/** TEAM-12: one line on a scorecard: the panel decision for this candidate, with a link to the candidate page. */
export function DecisionNote({ decision, to }: { decision: PanelDecision; to: string }) {
  return (
    <div className="pd-note" data-testid="decision-note">
      <span className="pd-note__label">Panel decision</span>
      <RecommendationBadge value={decision.recommendation} />
      <span className="pd-note__why">{decision.rationale}</span>
      <Link to={to} className="no-print">
        Candidate summary
      </Link>
    </div>
  );
}

/**
 * SUM-4: the written summary of a candidate, saved as it is typed (RES-1) with who last edited it
 * and when.
 */
export function WrittenSummaryEditor({ refId, summary, headingLevel = 2 }: { refId: string; summary: WrittenSummary | null; headingLevel?: 2 | 3 }) {
  const H = `h${headingLevel}` as 'h2' | 'h3';
  const [text, setText] = useState(summary?.text ?? '');
  const [state, setState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [error, setError] = useState<string | null>(null);
  const dirty = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Follow changes made elsewhere (another tab, an import) while not typing here.
  useEffect(() => {
    if (!dirty.current) setText(summary?.text ?? '');
  }, [summary?.text]);
  const save = async (value: string) => {
    setState('saving');
    try {
      await saveWrittenSummary(refId, value);
      dirty.current = false;
      setState('saved');
      setError(null);
    } catch (err) {
      setState('error');
      setError(err instanceof RepoError ? err.message : 'The summary could not be saved.');
    }
  };
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  return (
    <section className="ws" aria-labelledby="ws-h">
      <div className="ws__head">
        <H id="ws-h">Written summary</H>
        <p className="small muted ws__status" aria-live="polite" data-testid="summary-status">
          {state === 'saving'
            ? 'Saving…'
            : state === 'error'
              ? ''
              : summary
                ? `Saved · last edited by ${summary.updatedBy}, ${formatDateTime(summary.updatedAt)}`
                : 'Saved as you type'}
        </p>
      </div>
      <TextArea
        aria-labelledby="ws-h"
        className="ws__text"
        rows={4}
        maxLength={MAX_SUMMARY}
        value={text}
        placeholder="A few lines for the hiring manager: what stood out, the main risk, the recommendation in your words."
        onChange={(e) => {
          const value = e.target.value;
          setText(value);
          dirty.current = true;
          if (timer.current) clearTimeout(timer.current);
          timer.current = setTimeout(() => void save(value), 600);
        }}
        onBlur={() => {
          if (!dirty.current) return;
          if (timer.current) clearTimeout(timer.current);
          void save(text);
        }}
      />
      {error && (
        <p className="field__error" role="alert">
          <Icon name="alert" /> {error}
        </p>
      )}
    </section>
  );
}

/**
 * TEAM-13: export a panel file for one or more candidates. The transcript and the AI second opinion
 * are included only when ticked; recordings never are.
 */
export function PanelFileDialog({ open, onClose, refs, what }: { open: boolean; onClose: () => void; refs: string[]; what: string }) {
  const { toast } = useToast();
  const [transcript, setTranscript] = useState(false);
  const [ai, setAi] = useState(false);
  const [busy, setBusy] = useState(false);
  const [shownOpen, setShownOpen] = useState(open);
  if (open !== shownOpen) {
    setShownOpen(open);
    if (open) {
      setTranscript(false);
      setAi(false);
    }
  }
  const run = async () => {
    setBusy(true);
    try {
      const f = await exportPanelFile(refs, { transcript, ai });
      downloadFile(f.fileName, f.mime, f.text);
      toast(
        `Panel file saved: ${f.panels} candidate${f.panels === 1 ? '' : 's'}, ${f.judgements} judgement${f.judgements === 1 ? '' : 's'}${f.leftOut ? `; ${f.leftOut} hidden until your own is submitted were left out` : ''}.`,
        'success',
      );
      onClose();
    } catch (err) {
      toast(err instanceof RepoError ? err.message : 'The panel file could not be saved.', 'error');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Export a panel file"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" icon="download" onClick={run} disabled={busy}>
            Export panel file
          </Button>
        </>
      }
    >
      <div className="stack">
        <p>
          Everything held here for {what}: every judgement (including ones entered by hand), the panel decision and the written summary. Import it on another computer with
          “Import files”.
        </p>
        <Checkbox label="Include transcripts" checked={transcript} onChange={(e) => setTranscript(e.target.checked)} />
        <Checkbox label="Include the AI second opinion" checked={ai} onChange={(e) => setAi(e.target.checked)} />
        <p className="small muted">Recordings are never included. Send the file the way your organisation allows for candidate information.</p>
      </div>
    </Dialog>
  );
}
