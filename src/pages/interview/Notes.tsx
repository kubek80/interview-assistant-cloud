import { forwardRef, useId, useState, type KeyboardEvent } from 'react';
import { Button, IconButton } from '../../ui/Button';
import { Select, TextArea } from '../../ui/Field';
import { ConfirmDialog } from '../../ui/Dialog';
import { Icon } from '../../ui/Icon';
import { DocLink } from '../../docs/DocLink';
import { formatSeconds } from '../../ui/format';
import type { NoteEntry } from '../../domain/types';

/** One note in a list: elapsed-time stamp and text (always rendered as text, SEC-2). */
export function NoteStamp({ atSec }: { atSec: number }) {
  return (
    <span className="note__time tabular">
      <span className="visually-hidden">At </span>
      {formatSeconds(atSec)}
      <span className="visually-hidden"> elapsed</span>
    </span>
  );
}

export function NeedsNoteIndicator() {
  return (
    <p className="needs-note" role="note">
      <Icon name="note" />
      <span>
        <strong>Note required.</strong> A score of 1 or 4 needs a note of what the candidate said. You cannot finish until it has one.
      </span>
      <DocLink req="FLOW-16" />
    </p>
  );
}

interface EntryProps {
  note: NoteEntry;
  index: number;
  editable: boolean;
  onSave: (text: string) => void | Promise<void>;
  onDelete: () => void | Promise<void>;
}

function NoteItem({ note, index, editable, onSave, onDelete }: EntryProps) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(note.text);
  const [confirm, setConfirm] = useState(false);
  const id = useId();
  const save = async () => {
    if (!value.trim()) {
      setConfirm(true);
      return;
    }
    await onSave(value.trim());
    setEditing(false);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault(); // handled here: cancel the edit (the page-level Esc would only blur)
      setEditing(false);
      setValue(note.text);
    } else if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void save();
    }
  };
  return (
    <li className="note">
      <NoteStamp atSec={note.atSec} />
      {editing ? (
        <div className="note__edit stack-sm">
          <label htmlFor={id} className="visually-hidden">
            Edit note {index + 1}
          </label>
          <TextArea id={id} value={value} onChange={(e) => setValue(e.target.value)} onKeyDown={onKeyDown} rows={2} autoFocus />
          <div className="cluster">
            <Button size="sm" variant="primary" onClick={save}>
              Save note
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setEditing(false);
                setValue(note.text);
              }}
            >
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <p className="note__text pre-wrap">
          {note.by && (
            <span className="note__by">
              {note.by}
              <span className="visually-hidden">:</span>
            </span>
          )}
          {note.text}
        </p>
      )}
      {editable && !editing && (
        <span className="note__actions">
          <IconButton
            icon="edit"
            size="sm"
            label={`Edit note ${index + 1}`}
            onClick={() => {
              setValue(note.text);
              setEditing(true);
            }}
          />
          <IconButton icon="trash" size="sm" label={`Delete note ${index + 1}`} onClick={() => setConfirm(true)} />
        </span>
      )}
      <ConfirmDialog
        open={confirm}
        title="Delete this note?"
        confirmLabel="Delete note"
        danger
        onCancel={() => setConfirm(false)}
        onConfirm={async () => {
          await onDelete();
          setConfirm(false);
          setEditing(false);
        }}
      >
        <p className="pre-wrap">{note.text}</p>
      </ConfirmDialog>
    </li>
  );
}

export interface NotesListProps {
  notes: NoteEntry[];
  /** Index hidden from the list (the entry currently being typed in the add field). */
  hideIndex?: number | null;
  editable: boolean;
  onSave?: (index: number, text: string) => void | Promise<void>;
  onDelete?: (index: number) => void | Promise<void>;
  /** Shown when there are no notes; empty string shows nothing. */
  emptyText?: string;
  /** Collapse all but the latest few notes behind a "Show earlier notes" button. */
  collapse?: boolean;
}

/** Notes shown before "Show N earlier notes" collapses the rest (the newest stay in view). */
const NOTES_SHOWN = 3;

export function NotesList({ notes, hideIndex = null, editable, onSave, onDelete, emptyText = 'No notes yet.', collapse = false }: NotesListProps) {
  const [expanded, setExpanded] = useState(false);
  const all = notes.map((n, i) => ({ n, i })).filter(({ i }) => i !== hideIndex);
  if (!all.length) return emptyText ? <p className="muted small">{emptyText}</p> : null;
  const hidden = collapse && !expanded ? Math.max(0, all.length - NOTES_SHOWN) : 0;
  const shown = all.slice(hidden);
  return (
    <div className="notes-list-wrap">
      {collapse && all.length > NOTES_SHOWN && (
        <Button size="sm" variant="ghost" icon={expanded ? 'chevron-down' : 'chevron-right'} aria-expanded={expanded} onClick={() => setExpanded(!expanded)} className="notes-list__more">
          {expanded ? 'Show only the latest notes' : `Show ${hidden} earlier note${hidden === 1 ? '' : 's'}`}
        </Button>
      )}
      <ol className="notes-list" aria-label="Notes for this question">
        {shown.map(({ n, i }) => (
          <NoteItem key={`${i}-${n.atSec}`} note={n} index={i} editable={editable} onSave={(text) => onSave?.(i, text)} onDelete={() => onDelete?.(i)} />
        ))}
      </ol>
    </div>
  );
}

export interface NoteComposerProps {
  value: string;
  onChange: (value: string) => void;
  onAdd: () => void;
  label?: string;
  /** Show the label (default); the live interview has a "Notes" heading right above instead. */
  showLabel?: boolean;
  /** PANEL-3: the interviewers, when more than one; the composer then offers who made the note. */
  authors?: readonly string[];
  by?: string;
  onByChange?: (by: string) => void;
}

/** FLOW-15: the "add a note" field. Enter adds the entry, Shift+Enter starts a new line. It grows as you type. */
export const NoteComposer = forwardRef<HTMLTextAreaElement, NoteComposerProps>(function NoteComposer(
  { value, onChange, onAdd, label = 'Add a note', showLabel = true, authors = [], by = '', onByChange },
  ref,
) {
  const id = useId();
  const byId = `${id}-by`;
  return (
    <div className="note-composer">
      <label htmlFor={id} className={showLabel ? 'field__label' : 'visually-hidden'}>
        {label}
      </label>
      <TextArea
        ref={ref}
        id={id}
        rows={2}
        className="note-composer__field"
        value={value}
        aria-describedby={`${id}-hint`}
        aria-keyshortcuts="/"
        placeholder="What did the candidate say?"
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            onAdd();
          }
        }}
      />
      <div className="note-composer__row">
        {authors.length > 1 && (
          <span className="note-by-field">
            <label htmlFor={byId} className="small">
              Note by
            </label>
            <Select
              id={byId}
              className="select--compact"
              value={by}
              onChange={(e) => onByChange?.(e.target.value)}
              options={[{ value: '', label: 'Not marked' }, ...authors.map((a) => ({ value: a, label: a }))]}
            />
          </span>
        )}
        <span className="note-composer__hint" id={`${id}-hint`}>
          Enter adds it · Shift+Enter for a new line · Esc to leave
        </span>
        <Button size="sm" icon="plus" onClick={onAdd} disabled={!value.trim()}>
          Add note
        </Button>
      </div>
    </div>
  );
});
