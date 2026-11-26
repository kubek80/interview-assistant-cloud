import { useId, useState, type FormEvent, type KeyboardEvent } from 'react';
import { RepoError, saveQuestion, type SaveQuestionResult } from '../../db';
import {
  changedVersionedFields,
  defaultTimeMin,
  draftFromQuestion,
  emptyDraft,
  offersBehaviouralStartingItems,
  validateQuestionDraft,
  withBehaviouralStartingItems,
  type DraftErrors,
  type DraftField,
  type QuestionDraft,
} from '../../domain/bankEdit';
import { DIFFICULTY_LABEL, RUBRIC_LEVELS, TYPE_LABEL } from '../../domain/rubric';
import { DIFFICULTIES, QUESTION_TYPES, type Category, type Difficulty, type Question, type QuestionType, type ScoreKey } from '../../domain/types';
import { Alert, Button, ConfirmDialog, Dialog, DocLink, Field, Select, TextArea, TextInput } from '../../ui';
import { ListEditor } from './ListEditor';

export type EditorMode = { kind: 'add'; categoryId?: string } | { kind: 'edit'; question: Question } | { kind: 'duplicate'; from: Question };

const NEW_CATEGORY = '__new__';

const VERSION_FIELD_LABEL: Record<string, string> = {
  text: 'text',
  description: 'description',
  difficulty: 'difficulty',
  type: 'type',
  lookFor: 'key points',
  redFlags: 'red flags',
  probes: 'probes',
  rubricOverride: 'rubric descriptions',
};

export interface QuestionEditorProps {
  /** null when closed. */
  mode: EditorMode | null;
  trackId: string;
  categories: readonly Category[];
  onClose: () => void;
  onSaved: (result: SaveQuestionResult, mode: EditorMode) => void;
}

function title(mode: EditorMode | null): string {
  if (!mode) return '';
  if (mode.kind === 'edit') return `Edit question ${mode.question.number}`;
  if (mode.kind === 'duplicate') return `New question from question ${mode.from.number}`;
  return 'Add a question';
}

/** BANK-9…BANK-11: add, edit or duplicate a question in a dialog. */
export function QuestionEditor({ mode, trackId, categories, onClose, onSaved }: QuestionEditorProps) {
  const formId = useId();
  const [dirty, setDirty] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [busy, setBusy] = useState(false);
  // A new form (fresh state) every time the dialog opens.
  const [openCount, setOpenCount] = useState(0);
  const [shownMode, setShownMode] = useState<EditorMode | null>(null);
  if (mode !== shownMode) {
    setShownMode(mode);
    if (mode) {
      setOpenCount((n) => n + 1);
      setDirty(false);
    }
  }
  const requestClose = () => (dirty ? setConfirmDiscard(true) : onClose());

  return (
    <>
      <Dialog
        open={!!mode}
        onClose={requestClose}
        wide
        title={title(mode)}
        footer={
          <>
            <span className="small muted grow qe-hint">
              <kbd className="kbd">Ctrl</kbd>+<kbd className="kbd">Enter</kbd> saves
            </span>
            <Button onClick={requestClose}>Cancel</Button>
            <Button variant="primary" type="submit" form={formId} disabled={busy} aria-keyshortcuts="Control+Enter Meta+Enter">
              {mode?.kind === 'edit' ? 'Save changes' : 'Add question'}
            </Button>
          </>
        }
      >
        {mode && (
          <EditorForm
            key={openCount}
            formId={formId}
            mode={mode}
            trackId={trackId}
            categories={categories}
            onDirty={setDirty}
            onBusy={setBusy}
            onSaved={(r) => {
              setDirty(false);
              onSaved(r, mode);
            }}
          />
        )}
      </Dialog>
      <ConfirmDialog
        open={confirmDiscard}
        title="Discard your changes?"
        confirmLabel="Discard changes"
        cancelLabel="Keep editing"
        danger
        onCancel={() => setConfirmDiscard(false)}
        onConfirm={() => {
          setConfirmDiscard(false);
          setDirty(false);
          onClose();
        }}
      >
        <p>The question has changes that are not saved.</p>
      </ConfirmDialog>
    </>
  );
}

interface EditorFormProps {
  formId: string;
  mode: EditorMode;
  trackId: string;
  categories: readonly Category[];
  onDirty: (dirty: boolean) => void;
  onBusy: (busy: boolean) => void;
  onSaved: (r: SaveQuestionResult) => void;
}

function initialDraft(mode: EditorMode, categories: readonly Category[]): QuestionDraft {
  if (mode.kind === 'edit') return draftFromQuestion(mode.question);
  if (mode.kind === 'duplicate') return draftFromQuestion(mode.from);
  return emptyDraft(mode.categoryId ?? (categories.length === 1 ? categories[0].id : ''));
}

function EditorForm({ formId, mode, trackId, categories, onDirty, onBusy, onSaved }: EditorFormProps) {
  const p = useId();
  const ids: Record<DraftField, string> = {
    text: `${p}-text`,
    description: `${p}-desc`,
    categoryId: `${p}-cat`,
    type: `${p}-type`,
    difficulty: `${p}-diff`,
    timeMin: `${p}-time`,
    lookFor: `${p}-l0`,
    redFlags: `${p}-r0`,
    probes: `${p}-p0`,
    rubricOverride: `${p}-rub1`,
  };
  const [start] = useState(() => initialDraft(mode, categories));
  const [draft, setDraft] = useState<QuestionDraft>(start);
  const [timeText, setTimeText] = useState(String(start.timeMin));
  // BANK-10: the estimate follows the table until the user types their own.
  const [timeAuto, setTimeAuto] = useState(mode.kind === 'add' || start.timeMin === defaultTimeMin(start.type, start.difficulty));
  const [newCategoryName, setNewCategoryName] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const [saveError, setSaveError] = useState<{ message: string; details: string[] } | null>(null);
  const [startSnapshot] = useState(() => JSON.stringify([start, '']));

  const set = (patch: Partial<QuestionDraft>) => {
    const next = { ...draft, ...patch };
    if (next.type === 'behavioural') next.difficulty = 'core'; // RUB-6
    if (timeAuto && (patch.type || patch.difficulty)) {
      next.timeMin = defaultTimeMin(next.type, next.difficulty);
      setTimeText(String(next.timeMin));
    }
    setDraft(next);
    onDirty(JSON.stringify([next, newCategoryName]) !== startSnapshot);
  };

  const creatingCategory = draft.categoryId === NEW_CATEGORY;
  const effective: QuestionDraft = { ...draft, timeMin: timeText.trim() === '' ? NaN : Number(timeText) };
  const knownIds = [...categories.map((c) => c.id), ...(creatingCategory && newCategoryName.trim() ? [NEW_CATEGORY] : [])];
  const errors: DraftErrors = validateQuestionDraft(effective, knownIds);
  if (creatingCategory && !newCategoryName.trim()) errors.categoryId = 'Enter a name for the new category.';
  else if (creatingCategory && categories.some((c) => c.name.trim().toLowerCase() === newCategoryName.trim().toLowerCase())) {
    errors.categoryId = 'There is already a category with this name: choose it from the list.';
  }
  const shown = submitted ? errors : {};
  const suggestedTime = defaultTimeMin(draft.type, draft.difficulty);
  const behavioural = draft.type === 'behavioural';
  const before = mode.kind === 'edit' ? mode.question : null;
  const bumpFields = before ? changedVersionedFields(before, effective) : [];

  const submit = async (e?: FormEvent) => {
    e?.preventDefault();
    setSubmitted(true);
    const order: DraftField[] = ['text', 'description', 'categoryId', 'type', 'difficulty', 'timeMin', 'lookFor', 'redFlags', 'probes', 'rubricOverride'];
    const first = order.find((f) => errors[f]);
    if (first) {
      document.getElementById(ids[first])?.focus();
      return;
    }
    onBusy(true);
    setSaveError(null);
    try {
      const r = await saveQuestion({
        trackId,
        id: mode.kind === 'edit' ? mode.question.id : undefined,
        draft: creatingCategory ? { ...effective, categoryId: '' } : effective,
        newCategory: creatingCategory ? { name: newCategoryName.trim() } : undefined,
      });
      onSaved(r);
    } catch (err) {
      setSaveError({ message: err instanceof Error ? err.message : 'The question could not be saved.', details: err instanceof RepoError ? err.details : [] });
    } finally {
      onBusy(false);
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLFormElement>) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      void submit();
    }
  };

  const errorCount = Object.keys(shown).length;
  return (
    <form id={formId} className="q-editor stack" onSubmit={submit} onKeyDown={onKeyDown} noValidate>
      {mode.kind === 'duplicate' && <p className="small muted">A copy of question {mode.from.number}. It is saved as a new question with the next free number.</p>}
      {errorCount > 0 && (
        <Alert tone="danger" title={`${errorCount} field${errorCount === 1 ? ' needs' : 's need'} attention before saving.`} role="alert" />
      )}
      {saveError && (
        <Alert tone="danger" title={`Not saved: ${saveError.message}`} role="alert">
          {saveError.details.length > 0 && (
            <ul className="adm-errors">
              {saveError.details.map((d, i) => (
                <li key={i}>{d}</li>
              ))}
            </ul>
          )}
        </Alert>
      )}
      <Field label="Question" required error={shown.text} hint="What you ask the candidate. It is shown on the candidate view.">
        <TextArea id={ids.text} data-autofocus rows={2} value={draft.text} onChange={(e) => set({ text: e.target.value })} />
      </Field>
      <Field
        label="Description (for the interviewer)"
        required
        error={shown.description}
        hint={
          <>
            Plain-language explanation to read out or paraphrase if the candidate has not understood the question. Restate the question and its
            scope; do not give away the key points. Never shown to the candidate. <DocLink req="BANK-8" />
          </>
        }
      >
        <TextArea id={ids.description} rows={3} value={draft.description} onChange={(e) => set({ description: e.target.value })} />
      </Field>

      <div className="q-editor__row">
        <Field label="Category" required error={shown.categoryId}>
          <Select
            id={ids.categoryId}
            value={draft.categoryId}
            onChange={(e) => set({ categoryId: e.target.value })}
            placeholder="Choose a category"
            options={[...categories.map((c) => ({ value: c.id, label: c.name })), { value: NEW_CATEGORY, label: 'New category…' }]}
          />
        </Field>
        {creatingCategory && (
          <Field label="New category name" required hint="Created when the question is saved.">
            <TextInput
              value={newCategoryName}
              onChange={(e) => {
                setNewCategoryName(e.target.value);
                onDirty(true);
              }}
              autoComplete="off"
            />
          </Field>
        )}
        <Field label="Type" required error={shown.type}>
          <Select id={ids.type} value={draft.type} onChange={(e) => set({ type: e.target.value as QuestionType })} options={QUESTION_TYPES.map((t) => ({ value: t, label: TYPE_LABEL[t] }))} />
        </Field>
        <Field label="Difficulty" required error={shown.difficulty} hint={behavioural ? 'Behavioural questions are always core.' : undefined}>
          <Select
            id={ids.difficulty}
            value={behavioural ? 'core' : draft.difficulty}
            disabled={behavioural}
            onChange={(e) => set({ difficulty: e.target.value as Difficulty })}
            options={DIFFICULTIES.map((d) => ({ value: d, label: DIFFICULTY_LABEL[d] }))}
          />
        </Field>
        <Field
          label="Time estimate (minutes)"
          required
          error={shown.timeMin}
          hint={timeAuto ? `From the table for ${TYPE_LABEL[draft.type].toLowerCase()}, ${DIFFICULTY_LABEL[behavioural ? 'core' : draft.difficulty].toLowerCase()}.` : `The table suggests ${suggestedTime} min.`}
        >
          <TextInput
            id={ids.timeMin}
            type="number"
            inputMode="numeric"
            min={1}
            max={120}
            step={1}
            value={timeText}
            onChange={(e) => {
              setTimeText(e.target.value);
              setTimeAuto(false);
              onDirty(true);
            }}
          />
        </Field>
      </div>
      {!timeAuto && Number(timeText) !== suggestedTime && (
        <div>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              setTimeAuto(true);
              setTimeText(String(suggestedTime));
              onDirty(true);
            }}
          >
            Use the table’s {suggestedTime} min
          </Button>
        </div>
      )}

      {offersBehaviouralStartingItems(draft.type, draft.lookFor) && (
        <Alert tone="info" title="Start from the behavioural themes?">
          <p>
            A behavioural question’s key points cover a specific real situation, the candidate’s own actions, a measurable result and reflection; its red flags
            cover hypothetical answers, blaming others and no outcome. Insert them as starting items, then reword them for this question. <DocLink req="RUB-5" />
          </p>
          <Button size="sm" icon="plus" onClick={() => {
              // The starting items, then an empty row for a key point of this question's own.
              const start = withBehaviouralStartingItems(draft.lookFor, draft.redFlags);
              set({ lookFor: [...start.lookFor, ''], redFlags: start.redFlags });
            }}>
            Insert the starting items
          </Button>
        </Alert>
      )}

      <div className="q-editor__lists">
        <ListEditor
          legend="L · Key points (what to look for)"
          noun="key point"
          items={draft.lookFor}
          onChange={(lookFor) => set({ lookFor })}
          error={shown.lookFor}
          firstInputId={ids.lookFor}
        />
        <ListEditor
          legend="R · Red flags"
          noun="red flag"
          items={draft.redFlags}
          onChange={(redFlags) => set({ redFlags })}
          error={shown.redFlags}
          firstInputId={ids.redFlags}
        />
        <ListEditor legend="P · Probes" noun="probe" items={draft.probes} onChange={(probes) => set({ probes })} error={shown.probes} firstInputId={ids.probes} />
      </div>

      <details className="q-editor__rubric" open={!!draft.rubricOverride || undefined}>
        <summary>Question-specific rubric descriptions (optional)</summary>
        <p className="small muted">
          Leave a level empty to use the shared description, shown greyed in each box. <DocLink req="RUB-2" />
        </p>
        <div className="stack-sm">
          {RUBRIC_LEVELS.map((l) => {
            const k = String(l.score) as ScoreKey;
            return (
              <Field key={k} label={`${l.score} – ${l.label}`} error={k === '1' ? shown.rubricOverride : undefined}>
                <TextArea
                  id={k === '1' ? ids.rubricOverride : undefined}
                  rows={2}
                  placeholder={l.description}
                  value={draft.rubricOverride?.[k] ?? ''}
                  onChange={(e) => set({ rubricOverride: { ...(draft.rubricOverride ?? {}), [k]: e.target.value } })}
                />
              </Field>
            );
          })}
        </div>
      </details>

      {before && (
        <p className="small q-editor__version">
          {bumpFields.length
            ? `Saving raises the version from ${before.version} to ${before.version + 1} (changed: ${bumpFields.map((f) => VERSION_FIELD_LABEL[f]).join(', ')}). Interviews already set up keep their own copy.`
            : `Version ${before.version}. Changes to the category, time estimate or status do not change the version.`}{' '}
          <DocLink req="BANK-11" />
        </p>
      )}
    </form>
  );
}
