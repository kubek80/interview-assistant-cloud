import { useId, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router';
import { WEIGHT_RANGE, addCategory, createTrack, newTrackProblems, removeCategory, updateCategory } from '../../db';
import { monthVersion } from '../../domain/bankEdit';
import type { Category, Question } from '../../domain/types';
import { Alert, Button, Checkbox, Dialog, DocLink, Field, Icon, IconButton, TextInput, useToast } from '../../ui';

const errText = (err: unknown) => (err instanceof Error ? err.message : 'Could not save.');

/** BANK-12: add, rename and reweight categories; remove only when no question uses them. */
export function CategoryManager({ open, onClose, trackId, trackName, categories, questions }: {
  open: boolean;
  onClose: () => void;
  trackId: string;
  trackName: string;
  categories: readonly Category[];
  questions: readonly Question[];
}) {
  return (
    <Dialog open={open} onClose={onClose} wide title={`Categories of ${trackName}`} footer={<Button onClick={onClose}>Done</Button>}>
      <div className="stack">
        <p className="small">
          The weight and must-have flag are the defaults for new interviews (each interview can change them under More options). Renaming does not
          affect interviews already set up. A category can be removed once no question uses it, retired ones included. <DocLink req="BANK-12" />
        </p>
        <div className="table-wrap">
          <table className="table table--compact cat-table pc-rtable">
            <caption className="visually-hidden">Categories</caption>
            <thead>
              <tr>
                <th scope="col">Name</th>
                <th scope="col">Default weight</th>
                <th scope="col">Must-have</th>
                <th scope="col" className="num">
                  Questions
                </th>
                <th scope="col">
                  <span className="visually-hidden">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {categories.map((c) => (
                <CategoryRow key={`${c.id}|${c.name}|${c.weight}|${c.mustHave}`} category={c} count={questions.filter((q) => q.categoryId === c.id).length} only={categories.length === 1} />
              ))}
            </tbody>
          </table>
        </div>
        <AddCategory trackId={trackId} />
      </div>
    </Dialog>
  );
}

function CategoryRow({ category: c, count, only }: { category: Category; count: number; only: boolean }) {
  const [name, setName] = useState(c.name);
  const [weight, setWeight] = useState(String(c.weight));
  const [error, setError] = useState<string | null>(null);
  const errId = useId();
  const { toast } = useToast();
  const save = async (patch: Parameters<typeof updateCategory>[1]) => {
    try {
      await updateCategory(c.id, patch);
      setError(null);
    } catch (err) {
      setError(errText(err));
    }
  };
  const canRemove = count === 0 && !only;
  return (
    <tr>
      <td data-label="Name">
        <TextInput
          aria-label={`Name of ${c.name}`}
          aria-describedby={error ? errId : undefined}
          aria-invalid={error ? true : undefined}
          value={name}
          onChange={(e) => setName(e.target.value)}
          onBlur={() => name.trim() !== c.name && save({ name })}
          onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), name.trim() !== c.name && save({ name }))}
        />
        {error && (
          <div id={errId} className="field__error">
            <Icon name="alert" />
            <span>{error}</span>
          </div>
        )}
      </td>
      <td data-label="Weight">
        <TextInput
          className="cat-table__weight"
          type="number"
          min={WEIGHT_RANGE[0]}
          max={WEIGHT_RANGE[1]}
          step={0.1}
          aria-label={`Default weight of ${c.name}`}
          value={weight}
          onChange={(e) => setWeight(e.target.value)}
          onBlur={() => Number(weight) !== c.weight && save({ weight: Number(weight) })}
        />
      </td>
      <td data-label="Must-have">
        <Checkbox label={<span className="visually-hidden">Must-have: {c.name}</span>} checked={c.mustHave} onChange={(e) => save({ mustHave: e.target.checked })} />
      </td>
      <td className="num" data-label="Questions">
        {count}
      </td>
      <td className="pc-rtable__actions">
        <IconButton
          icon="trash"
          size="sm"
          label={canRemove ? `Remove ${c.name}` : `${c.name} cannot be removed: ${only ? 'a track needs a category' : `${count} question${count === 1 ? '' : 's'} use it`}`}
          aria-disabled={!canRemove || undefined}
          onClick={async () => {
            if (!canRemove) {
              setError(only ? 'A track needs at least one category.' : `${count} question${count === 1 ? '' : 's'} (retired ones included) still use this category. Move them to another category first.`);
              return;
            }
            try {
              await removeCategory(c.id);
              toast(`Removed the category “${c.name}”.`, 'success');
            } catch (err) {
              setError(errText(err));
            }
          }}
        />
      </td>
    </tr>
  );
}

function AddCategory({ trackId }: { trackId: string }) {
  const [name, setName] = useState('');
  const [weight, setWeight] = useState('1');
  const [mustHave, setMustHave] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { toast } = useToast();
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    try {
      await addCategory(trackId, { name, weight: Number(weight), mustHave });
      toast(`Added the category “${name.trim()}”.`, 'success');
      setName('');
      setWeight('1');
      setMustHave(false);
      setError(null);
    } catch (err) {
      setError(errText(err));
    }
  };
  return (
    <form className="cat-add" onSubmit={submit} aria-label="Add a category">
      <h3 className="q-detail__list-title">Add a category</h3>
      <div className="cat-add__fields">
        <Field label="Name" error={error}>
          <TextInput value={name} onChange={(e) => setName(e.target.value)} autoComplete="off" />
        </Field>
        <Field label="Default weight">
          <TextInput type="number" min={WEIGHT_RANGE[0]} max={WEIGHT_RANGE[1]} step={0.1} value={weight} onChange={(e) => setWeight(e.target.value)} />
        </Field>
        <Checkbox label="Must-have" checked={mustHave} onChange={(e) => setMustHave(e.target.checked)} />
        <Button type="submit" icon="plus">
          Add category
        </Button>
      </div>
    </form>
  );
}

/** Suggests a track id from its name: the first word after "Senior", e.g. "Senior Data Engineer" → "data". */
function suggestId(name: string): string {
  const words = name
    .toLowerCase()
    .replace(/\(.*?\)/g, ' ')
    .replace(/^senior\s+/, '')
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  const id = (words[0] ?? '').replace(/^[0-9]+/, '').slice(0, 30);
  return id;
}

/** BANK-12: create a new track (id slug validated and unique, name, first category). */
export function NewTrackDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <Dialog open={open} onClose={onClose} title="New track">
      {open && <NewTrackForm onClose={onClose} />}
    </Dialog>
  );
}

function NewTrackForm({ onClose }: { onClose: () => void }) {
  const navigate = useNavigate();
  const { toast } = useToast();
  const [name, setName] = useState('');
  const [id, setId] = useState<string | null>(null);
  const [category, setCategory] = useState('');
  const [version, setVersion] = useState(() => monthVersion(new Date()));
  const [errors, setErrors] = useState<Partial<Record<'id' | 'name' | 'version' | 'category' | 'form', string>>>({});
  const shownId = id ?? suggestId(name);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const p: typeof errors = { ...(await newTrackProblems({ id: shownId, name, version })) };
    if (!category.trim()) p.category = 'Enter the first category, for example “Fundamentals”.';
    setErrors(p);
    const first = (['name', 'id', 'version', 'category'] as const).find((k) => p[k]);
    if (first) {
      document.getElementById(`nt-${first}`)?.focus();
      return;
    }
    try {
      const created = await createTrack({ id: shownId, name, version, firstCategory: { name: category } });
      toast(`Created the track ${name.trim()}. Add its questions next.`, 'success');
      onClose();
      navigate(`/bank/${created}`);
    } catch (err) {
      setErrors({ form: errText(err) });
    }
  };

  return (
    <form className="stack" onSubmit={submit} noValidate>
      <p className="small">A new track starts empty: add its questions before using it for an interview. <DocLink req="BANK-12" /></p>
      {errors.form && <Alert tone="danger" title={errors.form} role="alert" />}
      <Field label="Track name" required error={errors.name}>
        <TextInput id="nt-name" data-autofocus value={name} onChange={(e) => setName(e.target.value)} autoComplete="off" placeholder="Senior Data Engineer" />
      </Field>
      <Field label="Track id" required error={errors.id} hint="Short, lower-case letters and digits, starting with a letter. Used in question ids and the file name; it cannot be changed later.">
        <TextInput id="nt-id" value={shownId} onChange={(e) => setId(e.target.value.toLowerCase())} autoComplete="off" spellCheck={false} />
      </Field>
      <Field label="First category" required error={errors.category}>
        <TextInput id="nt-category" value={category} onChange={(e) => setCategory(e.target.value)} autoComplete="off" />
      </Field>
      <Field label="Track version" required error={errors.version}>
        <TextInput id="nt-version" value={version} onChange={(e) => setVersion(e.target.value)} autoComplete="off" spellCheck={false} />
      </Field>
      <div className="pc-dialog-actions">
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="primary" type="submit" icon="plus">
          Create track
        </Button>
      </div>
    </form>
  );
}
