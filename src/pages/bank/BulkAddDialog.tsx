import { useEffect, useId, useMemo, useRef, useState, type ChangeEvent } from 'react';
import { RepoError, bulkAddQuestions } from '../../db';
import { CSV_COLUMNS, CSV_HEADERS, bulkTemplateCsv, parseBulkQuestions, type BulkParse } from '../../domain/bankCsv';
import { DIFFICULTY_LABEL, TYPE_LABEL } from '../../domain/rubric';
import type { Category, Question } from '../../domain/types';
import { Alert, Badge, Button, Checkbox, Dialog, DocLink, Field, Icon, TextArea, downloadFile, useToast } from '../../ui';

const MAX_FILE_BYTES = 2 * 1024 * 1024;

export interface BulkAddDialogProps {
  open: boolean;
  trackId: string;
  trackName: string;
  categories: readonly Category[];
  questions: readonly Question[];
  onClose: () => void;
}

/**
 * BANK-13: paste rows from a spreadsheet or import a CSV file, see a preview with each row's
 * problems, and add nothing until the preview is accepted.
 */
export function BulkAddDialog(props: BulkAddDialogProps) {
  const [step, setStep] = useState<'input' | 'preview'>('input');
  const [shownOpen, setShownOpen] = useState(props.open);
  const [text, setText] = useState('');
  if (props.open !== shownOpen) {
    setShownOpen(props.open);
    if (props.open) {
      setStep('input');
      setText('');
    }
  }
  return (
    <Dialog open={props.open} onClose={props.onClose} wide title={step === 'input' ? `Bulk add questions to ${props.trackName}` : 'Check the rows before adding them'}>
      {props.open &&
        (step === 'input' ? (
          <InputStep text={text} setText={setText} onPreview={() => setStep('preview')} onCancel={props.onClose} />
        ) : (
          <PreviewStep {...props} text={text} onBack={() => setStep('input')} />
        ))}
    </Dialog>
  );
}

function InputStep({ text, setText, onPreview, onCancel }: { text: string; setText: (s: string) => void; onPreview: () => void; onCancel: () => void }) {
  const fileId = useId();
  const fileHint = useId();
  const ref = useRef<HTMLInputElement>(null);
  const pasteRef = useRef<HTMLTextAreaElement>(null);
  const [error, setError] = useState<string | null>(null);
  // Coming back from the preview: focus the pasted rows (A11Y-1).
  useEffect(() => pasteRef.current?.focus(), []);

  const onFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > MAX_FILE_BYTES) setError('The file is too large (2 MB at most).');
    else {
      setText(await file.text());
      setError(null);
      onPreview();
    }
    if (ref.current) ref.current.value = '';
  };

  return (
    <form
      className="stack"
      onSubmit={(e) => {
        e.preventDefault();
        if (!text.trim()) setError('Paste some rows or choose a file first.');
        else onPreview();
      }}
    >
      <p>
        One question per row, in these columns: {CSV_COLUMNS.map((c) => CSV_HEADERS[c]).join(', ')}. A header row is optional; when there is one, columns are
        matched by name. Separate the items of a list with <kbd className="kbd">;</kbd> or line breaks within the cell. An empty time is filled in from the
        table. <DocLink req="BANK-13" />
      </p>
      <Field label="Rows from a spreadsheet or CSV" error={error} hint="Copy the cells in your spreadsheet and paste them here.">
        <TextArea ref={pasteRef} data-autofocus rows={8} className="bulk__paste" value={text} onChange={(e) => setText(e.target.value)} spellCheck={false} />
      </Field>
      <div className="field">
        <label htmlFor={fileId} className="field__label">
          Or import a CSV file
        </label>
        <div id={fileHint} className="field__hint">
          Comma, semicolon or tab separated, with the same columns. Nothing is added until you accept the preview.
        </div>
        <input ref={ref} id={fileId} type="file" accept=".csv,.tsv,.txt,text/csv,text/tab-separated-values,text/plain" className="file-input" aria-describedby={fileHint} onChange={onFile} />
      </div>
      <div className="pc-dialog-actions">
        <Button icon="download" variant="ghost" className="bulk__template" onClick={() => downloadFile('question-bank-template.csv', 'text/csv', bulkTemplateCsv())}>
          Download the CSV template
        </Button>
        <Button onClick={onCancel}>Cancel</Button>
        <Button variant="primary" type="submit">
          Preview
        </Button>
      </div>
    </form>
  );
}

function PreviewStep({ text, trackId, categories, questions, onBack, onClose }: BulkAddDialogProps & { text: string; onBack: () => void }) {
  const { toast } = useToast();
  const parsed: BulkParse = useMemo(() => parseBulkQuestions(text, trackId, categories, questions.map((q) => q.text)), [text, trackId, categories, questions]);
  const [create, setCreate] = useState<Set<string>>(() => new Set(parsed.newCategories));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ message: string; details: string[] } | null>(null);
  const catName = new Map(categories.map((c) => [c.id, c.name]));
  const headRef = useRef<HTMLParagraphElement>(null);
  // The step replaces the form that had focus: move focus to the result (A11Y-1).
  useEffect(() => (headRef.current ?? document.querySelector<HTMLElement>('dialog[open] [data-autofocus]'))?.focus(), []);

  const rows = parsed.rows.map((r) => ({
    ...r,
    problems: r.newCategory && !create.has(r.newCategory) ? [...r.problems, `Category “${r.newCategory}” does not exist and will not be created.`] : r.problems,
  }));
  const good = rows.filter((r) => !r.problems.length);
  const bad = rows.length - good.length;

  const accept = async () => {
    setBusy(true);
    setError(null);
    try {
      const newCats = parsed.newCategories.filter((n) => create.has(n)).map((name) => ({ name, id: parsed.rows.find((r) => r.newCategory === name)!.draft.categoryId }));
      const r = await bulkAddQuestions(trackId, good.map((g) => g.draft), newCats);
      toast(`Added ${r.ids.length} question${r.ids.length === 1 ? '' : 's'}${r.categories.length ? ` and ${r.categories.length} categor${r.categories.length === 1 ? 'y' : 'ies'}` : ''}. Recorded in the audit log.`, 'success');
      onClose();
    } catch (err) {
      setError({ message: err instanceof Error ? err.message : 'Nothing was added.', details: err instanceof RepoError ? err.details : [] });
    } finally {
      setBusy(false);
    }
  };

  if (parsed.problem) {
    return (
      <div className="stack">
        <Alert tone="danger" title={parsed.problem} role="alert" />
        <div className="pc-dialog-actions">
          <Button data-autofocus onClick={onBack}>
            Back
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="stack">
      <p ref={headRef} tabIndex={-1} className="bulk__summary" role="status">
        <strong>
          {good.length} of {rows.length} row{rows.length === 1 ? '' : 's'} ready to add.
        </strong>{' '}
        {bad > 0 ? `${bad} row${bad === 1 ? ' has' : 's have'} problems and will not be added; fix them in your spreadsheet and paste again, or add the good rows now.` : 'No problems found.'}
        {parsed.header ? ' The first row was read as a header.' : ' No header row: columns are in the template order.'}
        {parsed.ignoredColumns.length > 0 && ` Ignored columns: ${parsed.ignoredColumns.join(', ')}.`}
      </p>
      {parsed.newCategories.length > 0 && (
        <fieldset className="bulk__newcats">
          <legend className="field__label">New categories</legend>
          <p className="small muted">These categories are not in the track yet. Create them, or untick to leave out their rows. <DocLink req="BANK-12" /></p>
          <div className="cluster">
            {parsed.newCategories.map((n) => (
              <Checkbox
                key={n}
                label={`Create “${n}”`}
                checked={create.has(n)}
                onChange={(e) => {
                  const next = new Set(create);
                  if (e.target.checked) next.add(n);
                  else next.delete(n);
                  setCreate(next);
                }}
              />
            ))}
          </div>
        </fieldset>
      )}
      <div className="table-wrap bulk__wrap" tabIndex={0} role="region" aria-label="Preview of the rows">
        <table className="table table--compact bulk__table pc-rtable">
          <caption className="visually-hidden">Rows to add, with their problems</caption>
          <thead>
            <tr>
              <th scope="col" className="num">
                Row
              </th>
              <th scope="col">Status</th>
              <th scope="col">Question</th>
              <th scope="col">Category</th>
              <th scope="col">Type</th>
              <th scope="col" className="num">
                L / R / P
              </th>
              <th scope="col" className="num">
                Time
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.line} className={r.problems.length ? 'bulk__row--bad' : undefined}>
                <td className="num" data-label="Row">
                  {r.line}
                </td>
                <td data-label="Status">
                  {r.problems.length ? (
                    <div className="stack-sm">
                      <Badge tone="danger" icon="alert">
                        {r.problems.length} problem{r.problems.length === 1 ? '' : 's'}
                      </Badge>
                      <ul className="bulk__problems">
                        {r.problems.map((p, i) => (
                          <li key={i}>{p}</li>
                        ))}
                      </ul>
                    </div>
                  ) : (
                    <Badge tone="success" icon="check">
                      Ready
                    </Badge>
                  )}
                </td>
                <td data-label="Question" className="bulk__text">
                  <div>
                    <span className="pre-wrap">{r.draft.text || <span className="muted">(no text)</span>}</span>
                    {r.draft.description && <span className="small muted pc-block">{r.draft.description}</span>}
                  </div>
                </td>
                <td data-label="Category">{r.newCategory ? `${r.newCategory} (new)` : (catName.get(r.draft.categoryId) ?? '–')}</td>
                <td data-label="Type">
                  {TYPE_LABEL[r.draft.type]}
                  {r.draft.type !== 'behavioural' && `, ${DIFFICULTY_LABEL[r.draft.difficulty].toLowerCase()}`}
                </td>
                <td className="num tabular" data-label="L / R / P">
                  {r.draft.lookFor.length} / {r.draft.redFlags.length} / {r.draft.probes.length}
                </td>
                <td className="num" data-label="Time">
                  {r.draft.timeMin} min
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {error && (
        <Alert tone="danger" title={`Nothing was added: ${error.message}`} role="alert">
          {error.details.length > 0 && (
            <ul className="adm-errors">
              {error.details.map((d, i) => (
                <li key={i}>{d}</li>
              ))}
            </ul>
          )}
        </Alert>
      )}
      <div className="pc-dialog-actions">
        <Button icon="chevron-left" onClick={onBack}>
          Back
        </Button>
        <Button variant="primary" onClick={accept} disabled={busy || good.length === 0}>
          <Icon name="plus" /> Add {good.length} question{good.length === 1 ? '' : 's'}
        </Button>
      </div>
    </div>
  );
}
