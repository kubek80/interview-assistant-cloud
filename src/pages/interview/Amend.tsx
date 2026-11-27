import { useState } from 'react';
import { Button, IconButton } from '../../ui/Button';
import { Card, Alert } from '../../ui/Card';
import { ReasonDialog } from '../../ui/Dialog';
import { TextArea } from '../../ui/Field';
import { DocLink } from '../../docs/DocLink';
import { RepoError, amendRecord } from '../../db';
import { scoreLabel } from '../../domain/rubric';
import { RECOMMENDATION_LABELS, type Answer, type NoteEntry, type OverallAssessment, type Question, type Score, type Session } from '../../domain/types';
import { ScoreControl } from './ScoreControl';
import { NoteStamp } from './Notes';
import { OverallFields } from './OverallFields';
import { describeAnswerAmendment, draftFromAnswer, draftNotes, type AnswerDraft } from './logic';

type AmendAnswerPatch = { score?: Score | null; notes?: NoteEntry[] };

/** RepoError details (e.g. which finish rule the change would break) folded into one message for ReasonDialog. */
function withDetails(e: unknown): Error {
  if (e instanceof RepoError && e.details.length) return new Error(`${e.message} ${e.details.join(' ')}`);
  return e instanceof Error ? e : new Error('Could not save the change.');
}

function ChangeList({ changes }: { changes: string[] }) {
  return (
    <div className="stack-sm">
      <p className="small muted">This change is written to the audit log with the values before and after, and your reason.</p>
      <ul className="amend-changes">
        {changes.map((c) => (
          <li key={c}>{c}</li>
        ))}
      </ul>
    </div>
  );
}

interface AmendAnswerProps {
  session: Session;
  question: Question;
  position: number;
  answer: Answer;
  onDone: () => void;
}

/** AUD-4: edit a submitted question's score or notes; the reason is asked for before the change is accepted. */
export function AmendAnswerForm({ session, question, position, answer, onDone }: AmendAnswerProps) {
  const [draft, setDraft] = useState<AnswerDraft>(() => draftFromAnswer(answer));
  const [asking, setAsking] = useState(false);
  const [nothing, setNothing] = useState(false);
  const changes = describeAnswerAmendment(answer, draft);
  const newNoteAt = Math.floor(session.timer.accumulatedMs / 1000);

  const setNote = (i: number, text: string) => setDraft((d) => ({ ...d, notes: d.notes.map((n, j) => (j === i ? { ...n, text } : n)) }));

  const save = async (reason: string) => {
    const patch: AmendAnswerPatch = {};
    if (draft.score !== answer.score) patch.score = draft.score;
    const notes = draftNotes(draft);
    if (JSON.stringify(notes) !== JSON.stringify(answer.notes)) patch.notes = notes;
    try {
      await amendRecord(session.id, {
        reason,
        question: { id: question.id, ...(patch.score !== undefined ? { score: patch.score } : {}), ...(patch.notes ? { notes: patch.notes.map((n) => ({ atSec: n.atSec, text: n.text, by: n.by ?? null })) } : {}) },
      });
    } catch (e) {
      throw withDetails(e);
    }
    setAsking(false);
    onDone();
  };

  return (
    <section className="amend-form stack" aria-labelledby="amend-answer-title">
      <div className="spread">
        <h3 id="amend-answer-title" className="pane__heading" tabIndex={-1}>
          Amend question {position}
        </h3>
        <DocLink req="AUD-4" />
      </div>
      <ScoreControl
        question={question}
        value={draft.score}
        onChange={(score) => setDraft((d) => ({ ...d, score }))}
        showKeys={false}
        legend="Score (amended)"
      />
      <fieldset className="stack-sm">
        <legend>Notes</legend>
        {draft.notes.length === 0 && <p className="small muted">No notes.</p>}
        <ol className="notes-list">
          {draft.notes.map((n, i) => (
            <li key={i} className="note note--editing">
              <NoteStamp atSec={n.atSec} />
              <TextArea
                aria-label={n.orig == null ? `New note ${i + 1}` : `Note ${n.orig + 1}`}
                rows={2}
                value={n.text}
                onChange={(e) => setNote(i, e.target.value)}
              />
              <span className="note__actions">
                <IconButton
                  icon="trash"
                  size="sm"
                  label={`Remove note ${i + 1}`}
                  onClick={() => setDraft((d) => ({ ...d, notes: d.notes.filter((_, j) => j !== i) }))}
                />
              </span>
            </li>
          ))}
        </ol>
        <div>
          <Button size="sm" icon="plus" onClick={() => setDraft((d) => ({ ...d, notes: [...d.notes, { atSec: newNoteAt, text: '', orig: null }] }))}>
            Add a note
          </Button>
        </div>
      </fieldset>
      {nothing && !changes.length && (
        <Alert tone="info" role="status">
          Nothing has changed yet.
        </Alert>
      )}
      <div className="cluster">
        <Button variant="primary" onClick={() => (changes.length ? setAsking(true) : setNothing(true))}>
          Save amendment…
        </Button>
        <Button variant="ghost" onClick={onDone}>
          Cancel
        </Button>
      </div>
      <ReasonDialog
        open={asking}
        title={`Amend question ${position}`}
        label="Reason for the change"
        hint="Required. Kept in the audit log."
        submitLabel="Save amendment"
        onCancel={() => setAsking(false)}
        onSubmit={save}
      >
        <ChangeList changes={changes} />
      </ReasonDialog>
    </section>
  );
}

function describeOverall(before: OverallAssessment, after: OverallAssessment): string[] {
  const out: string[] = [];
  const r = (x: OverallAssessment['rating']) => (x == null ? 'none' : `${x} (${scoreLabel(x)})`);
  const rec = (x: OverallAssessment['recommendation']) => (x == null ? 'none' : RECOMMENDATION_LABELS[x]);
  if (before.rating !== after.rating) out.push(`Overall rating: ${r(before.rating)} → ${r(after.rating)}`);
  if (before.recommendation !== after.recommendation) out.push(`Recommendation: ${rec(before.recommendation)} → ${rec(after.recommendation)}`);
  if (before.rationale.trim() !== after.rationale.trim()) out.push('Rationale edited');
  return out;
}

/** FLOW-22 (read-only view) and AUD-4 (amend the overall rating, recommendation or rationale). */
export function OverallPanel({ session }: { session: Session }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<OverallAssessment>(session.overall);
  const [asking, setAsking] = useState(false);
  const o = session.overall;
  const changes = describeOverall(o, draft);

  const save = async (reason: string) => {
    const patch: Partial<OverallAssessment> = {};
    if (draft.rating !== o.rating) patch.rating = draft.rating;
    if (draft.recommendation !== o.recommendation) patch.recommendation = draft.recommendation;
    if (draft.rationale.trim() !== o.rationale.trim()) patch.rationale = draft.rationale.trim();
    try {
      await amendRecord(session.id, { reason, overall: patch });
    } catch (e) {
      throw withDetails(e);
    }
    setAsking(false);
    setEditing(false);
  };

  return (
    <Card
      title="Overall assessment"
      className="overall-panel"
      actions={
        !editing && (
          <Button
            size="sm"
            icon="edit"
            onClick={() => {
              setDraft(session.overall);
              setEditing(true);
            }}
          >
            Amend overall
          </Button>
        )
      }
    >
      {editing ? (
        <div className="stack">
          <OverallFields value={draft} onChange={(p) => setDraft((d) => ({ ...d, ...p }))} idPrefix="amend-overall" />
          <div className="cluster">
            <Button variant="primary" onClick={() => changes.length && setAsking(true)} disabled={!changes.length}>
              Save amendment…
            </Button>
            <Button variant="ghost" onClick={() => setEditing(false)}>
              Cancel
            </Button>
          </div>
          <ReasonDialog
            open={asking}
            title="Amend the overall assessment"
            label="Reason for the change"
            hint="Required. Kept in the audit log."
            submitLabel="Save amendment"
            onCancel={() => setAsking(false)}
            onSubmit={save}
          >
            <ChangeList changes={changes} />
          </ReasonDialog>
        </div>
      ) : (
        <dl className="overall-summary">
          <div>
            <dt>Overall rating</dt>
            <dd>{o.rating ? `${o.rating} · ${scoreLabel(o.rating)}` : '–'}</dd>
          </div>
          <div>
            <dt>Recommendation</dt>
            <dd>{o.recommendation ? RECOMMENDATION_LABELS[o.recommendation] : '–'}</dd>
          </div>
          <div className="overall-summary__wide">
            <dt>Rationale</dt>
            <dd className="pre-wrap">{o.rationale || '–'}</dd>
          </div>
        </dl>
      )}
    </Card>
  );
}
