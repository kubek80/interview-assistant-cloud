import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { useLocation, useNavigate } from 'react-router';
import {
  RepoError,
  continueDraft,
  drawDraft,
  saveForLater,
  saveCandidateDraft,
  updatePlanDraft,
  useDefaultRetentionDays,
  useInterviewerName,
  usePlan,
  useRecordingNoticeDefault,
  useTrackBank,
  useTracks,
} from '../../db';
import { addDays, isoDate, totalTimeMin, type Quotas, type UnmetQuota } from '../../domain/plan';
import type { InterviewPlan, PlanCategory, Question } from '../../domain/types';
import { Alert, Button, Field, Icon, PageHeader, Select, TextInput, useToast } from '../../ui';
import { QuestionDetailDialog } from '../bank/QuestionDetail';
import { clearLegacyCandidateDraft, emptyCandidateDraft, type CandidateDraft } from './candidateDraft';
import { continueProblems, mixInWords, moveTo, normaliseInitials, parseBudget, parseWeight, shortfallInWords, toggleSelected, type ContinueField } from './logic';
import { MoreOptions } from './MoreOptions';
import { ReuseDialog } from './ReuseDialog';
import { SetEditor } from './SetEditor';
import { useAutosave } from './useAutosave';
import { useCandidateForm } from './useCandidateForm';
import { useKeepHeadingFocus } from './useKeepHeadingFocus';
import { clearMix, readMix, writeMix } from './mixMemory';
import { ScheduleDialog } from '../team/ScheduleDialog';

const FIELD_ID: Record<ContinueField, string> = {
  name: 'ni-name',
  initials: 'ni-initials',
  questions: 'ni-edit',
  budget: 'set-budget',
  requisitionId: 'ni-req',
  otherInterviewers: 'ni-otherInterviewers',
  retentionUntil: 'ni-retention',
  setName: 'ni-setname',
  weights: 'ni-weights',
};
const IN_MORE: readonly ContinueField[] = ['requisitionId', 'otherInterviewers', 'retentionUntil', 'setName', 'weights'];

/**
 * FLOW-33, UX-1, UX-2, UX-3: one screen sets up an interview. Role and candidate initials (and,
 * the first time, the interviewer's name), a question set already drawn and summarised, Shuffle,
 * Edit questions in place, everything else under "More options", and one "Continue" that pins the
 * set (FLOW-8) and opens the ready screen. Every change is saved as it is made (RES-1).
 */
export function NewInterviewScreen({ plan, initialCandidate }: { plan: InterviewPlan; initialCandidate: Partial<CandidateDraft> | null }) {
  const tracks = useTracks();
  const bank = useTrackBank(plan.trackId);
  const storedName = useInterviewerName();
  const retentionDays = useDefaultRetentionDays();
  const recordingDefault = useRecordingNoticeDefault();
  const navigate = useNavigate();
  const location = useLocation();
  const { toast, announce } = useToast();
  const { save, flush, saving } = useAutosave(plan.id);
  useKeepHeadingFocus();

  // ---- Candidate details (autosaved in order, RES-1)
  const candidateQueue = useRef<Promise<void>>(Promise.resolve());
  const form = useCandidateForm(
    () => ({ ...emptyCandidateDraft(''), ...initialCandidate }),
    storedName,
    (d) => {
      candidateQueue.current = candidateQueue.current
        .then(() => saveCandidateDraft(plan.id, d))
        .then(() => clearLegacyCandidateDraft(plan.id))
        .catch(() => toast('The candidate details could not be saved on this device.', 'error'));
    },
    retentionDays,
    recordingDefault,
  );
  const needsName = storedName !== undefined && !storedName?.trim();
  const reuseId = form.value.reusePlanId ?? null;
  const reusePlan = usePlan(reuseId ?? undefined);
  const reusing = !!reuseId && !!reusePlan;

  // ---- Questions: local order, kept in step with the saved plan
  const planIds = plan.questions.map((q) => q.id).join('|');
  const [ids, setIds] = useState<string[]>(() => plan.questions.map((q) => q.id));
  // While edits are still being written, the stored order lags behind; only follow it once saved
  // (draws, a role change and undo are written first, then shown).
  useEffect(() => {
    if (!saving()) setIds(planIds ? planIds.split('|') : []);
  }, [planIds]); // eslint-disable-line react-hooks/exhaustive-deps
  const byId = useMemo(() => {
    const m = new Map<string, Question>(plan.questions.map((q) => [q.id, q]));
    for (const q of bank?.questions ?? []) if (q.trackId === plan.trackId) m.set(q.id, q);
    return m;
  }, [bank, plan.questions, plan.trackId]);
  const selected = useMemo(() => ids.map((id) => byId.get(id)).filter((q): q is Question => !!q), [ids, byId]);
  const shown = reusing ? reusePlan!.questions : selected;

  const [budgetText, setBudgetText] = useState(String(plan.timeBudgetMin));
  const budget = parseBudget(budgetText);
  const budgetMin = reusing ? reusePlan!.timeBudgetMin : (budget.value ?? plan.timeBudgetMin);
  const [setName, setSetName] = useState(plan.name);
  useEffect(() => setSetName(plan.name), [plan.name]);
  const [cats, setCats] = useState<PlanCategory[]>(plan.categories);
  const catKey = plan.categories.map((c) => `${c.id}:${c.weight}:${c.mustHave}`).join('|');
  useEffect(() => setCats(plan.categories), [catKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const [weightText, setWeightText] = useState<Record<string, string>>({});
  const weightOf = (c: PlanCategory) => weightText[c.id] ?? String(c.weight);
  const weightErrors = Object.fromEntries(cats.map((c) => [c.id, parseWeight(weightOf(c)).error])) as Record<string, string | null>;
  const defaults = useMemo(() => new Map((bank?.categories ?? []).map((c) => [c.id, c])), [bank]);
  const changedCats = cats.filter((c) => {
    const d = defaults.get(c.id);
    return d && (d.weight !== c.weight || d.mustHave !== c.mustHave);
  });

  // UX-3: the mix and "Draw from" survive a reload (kept per set-up until it is continued).
  const [quotas, setQuotas] = useState<Quotas>(() => readMix(plan.id).quotas);
  const [drawFrom, setDrawFrom] = useState(() => readMix(plan.id).drawFrom);
  useEffect(() => writeMix(plan.id, { quotas, drawFrom }), [plan.id, quotas, drawFrom]);
  const [unmet, setUnmet] = useState<UnmetQuota[]>(() => ((location.state as { unmet?: UnmetQuota[] } | null)?.unmet ?? []));
  const [undo, setUndo] = useState<{ ids: string[]; message: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const [detail, setDetail] = useState<Question | null>(null);
  const [reuseOpen, setReuseOpen] = useState(false);
  const [error, setError] = useState<{ message: string; details: string[] } | null>(null);
  const [laterOpen, setLaterOpen] = useState(false);
  const problemsRef = useRef<HTMLDivElement>(null);

  // ---- Edits (each saved straight away)
  const setSelection = (next: string[]) => {
    setIds(next);
    void save({ questionIds: next });
  };
  const moveQ = (from: number, to: number) => {
    const next = moveTo(ids, from, to);
    setSelection(next);
    announce(`Question moved to position ${Math.max(1, Math.min(ids.length, to + 1))} of ${ids.length}.`);
  };
  const removeQ = (index: number) => {
    setSelection(ids.filter((_, i) => i !== index));
    announce('Question removed.');
  };
  const toggleQ = (id: string) => setSelection(toggleSelected(ids, id));

  const draw = async (opts: { trackId?: string; message: string }) => {
    setBusy(true);
    setError(null);
    const before = ids;
    try {
      await flush();
      const r = await drawDraft(plan.id, { trackId: opts.trackId, quotas, categoryIds: drawFrom && !opts.trackId ? [drawFrom] : [] });
      if (opts.trackId) {
        setDrawFrom('');
        setWeightText({});
      }
      setUnmet(r.unmet);
      setUndo(opts.trackId ? null : { ids: before, message: opts.message });
      announce(`${opts.message} ${r.questionIds.length} questions.`);
    } catch (err) {
      toast(err instanceof RepoError ? err.message : 'Could not draw new questions.', 'error');
    } finally {
      setBusy(false);
    }
  };
  const shuffle = () => {
    if (reusing) form.update({ reusePlanId: null });
    void draw({ message: 'New questions drawn.' });
  };
  const changeRole = (trackId: string) => {
    if (trackId === plan.trackId) return;
    form.update({ reusePlanId: null });
    void draw({ trackId, message: 'Questions drawn for the new role.' });
  };
  const undoDraw = () => {
    if (!undo) return;
    setSelection(undo.ids);
    setUndo(null);
    setUnmet([]);
    announce('Previous questions restored.');
    document.getElementById('ni-shuffle')?.focus();
  };
  const openEditor = () => {
    if (reusing) {
      // Editing makes a new set: start from a copy of the reused questions.
      form.update({ reusePlanId: null });
      setSelection(reusePlan!.questions.map((q) => q.id));
    }
    setEditing(true);
    requestAnimationFrame(() => document.getElementById('set-editor-title')?.focus());
  };
  const closeEditor = () => {
    setEditing(false);
    requestAnimationFrame(() => document.getElementById('ni-edit')?.focus());
  };
  const chooseReuse = async (p: InterviewPlan) => {
    setReuseOpen(false);
    try {
      await flush();
      if (p.trackId !== plan.trackId) await updatePlanDraft(plan.id, { trackId: p.trackId, questionIds: p.questions.map((q) => q.id) });
      form.update({ reusePlanId: p.id });
      setUnmet([]);
      setUndo(null);
      setEditing(false);
      announce(`Using the same ${p.questions.length} questions as “${p.name}”.`);
    } catch (err) {
      toast(err instanceof RepoError ? err.message : 'Could not use those questions.', 'error');
    }
  };
  const onBudget = (text: string) => {
    setBudgetText(text);
    const b = parseBudget(text);
    if (b.value !== null) void save({ timeBudgetMin: b.value });
  };
  const onSetName = (text: string) => {
    setSetName(text);
    if (text.trim()) void save({ name: text.trim().slice(0, 300) });
  };
  const onWeight = (id: string, text: string) => {
    setWeightText((w) => ({ ...w, [id]: text }));
    const w = parseWeight(text);
    if (w.value !== null) {
      setCats((cs) => cs.map((c) => (c.id === id ? { ...c, weight: w.value! } : c)));
      void save({ categories: [{ id, weight: w.value }] });
    }
  };
  const onMustHave = (id: string, mustHave: boolean) => {
    setCats((cs) => cs.map((c) => (c.id === id ? { ...c, mustHave } : c)));
    void save({ categories: [{ id, mustHave }] });
  };
  const resetWeights = () => {
    const next = cats.map((c) => {
      const d = defaults.get(c.id);
      return d ? { ...c, weight: d.weight, mustHave: d.mustHave } : c;
    });
    setCats(next);
    setWeightText({});
    void save({ categories: next.map((c) => ({ id: c.id, weight: c.weight, mustHave: c.mustHave })) });
    announce('Weights and must-have flags reset to the defaults.');
  };

  // ---- Continue (FLOW-8): pin the set, create the interview, open the ready screen
  const problems = continueProblems({
    questionCount: shown.length,
    budgetError: reusing ? null : budget.error,
    weightsInvalid: !reusing && Object.values(weightErrors).some(Boolean),
    setNameMissing: !reusing && !setName.trim(),
    candidateErrors: form.allErrors,
  });
  const showErr = (f: keyof typeof form.allErrors) => (form.attempted ? form.allErrors[f] : form.errors[f]);

  const focusProblem = (field: ContinueField) => {
    if (IN_MORE.includes(field)) setMoreOpen(true);
    if (field === 'budget') setEditing(true);
    requestAnimationFrame(() => {
      const id = field === 'weights' ? `weight-${cats.find((c) => weightErrors[c.id])?.id ?? ''}` : FIELD_ID[field];
      const el = document.getElementById(id);
      el?.scrollIntoView({ block: 'center' });
      el?.focus({ preventScroll: true });
    });
  };

  /** TEAM-1: the same checks as Continue, then the date, time, interviewers and note. */
  const openLater = () => {
    form.setAttempted(true);
    setError(null);
    if (problems.length) {
      focusProblem(problems[0].field);
      return;
    }
    setLaterOpen(true);
  };
  const saveLater = async (schedule: Parameters<typeof saveForLater>[2]) => {
    await flush();
    await candidateQueue.current;
    await saveForLater(plan.id, form.input, schedule);
    clearLegacyCandidateDraft(plan.id);
    clearMix(plan.id);
    setLaterOpen(false);
    toast(`Saved for later: ${form.input.initials.trim()}. It is under Upcoming.`, 'success');
    navigate('/');
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    form.setAttempted(true);
    setError(null);
    if (problems.length) {
      focusProblem(problems[0].field);
      return;
    }
    setBusy(true);
    try {
      await flush();
      await candidateQueue.current;
      const { sessionId } = await continueDraft(plan.id, form.input);
      clearLegacyCandidateDraft(plan.id);
      clearMix(plan.id);
      navigate(`/interview/${sessionId}`);
    } catch (err) {
      setBusy(false);
      setError(err instanceof RepoError ? { message: err.message, details: err.details } : { message: 'The interview could not be created.', details: [] });
      requestAnimationFrame(() => problemsRef.current?.focus());
    }
  };

  const minutes = totalTimeMin(shown);
  const over = minutes - budgetMin;
  const short = reusing ? null : shortfallInWords(unmet);
  const retention = isoDate(addDays(new Date(), retentionDays ?? 90));

  return (
    <>
      <PageHeader title="New interview" />
      <form className="ni" onSubmit={submit} noValidate aria-label="New interview">
        <div className="card ni-card">
          <div className={`ni-who${needsName ? ' ni-who--name' : ''}`}>
            {needsName && (
              <Field label="Your name" required error={showErr('interviewerName') ? 'Enter your name.' : null}>
                <TextInput
                  id="ni-name"
                  value={form.value.interviewerName}
                  onChange={(e) => form.update({ interviewerName: e.target.value.slice(0, 200) })}
                  onBlur={() => form.touch('interviewerName')}
                  autoComplete="name"
                />
              </Field>
            )}
            <Field label="Role">
              <Select id="ni-role" value={plan.trackId} onChange={(e) => changeRole(e.target.value)} disabled={busy} options={(tracks ?? []).map((t) => ({ value: t.id, label: t.name }))} />
            </Field>
            <Field label="Candidate" hint="Name or initials" required error={showErr('initials') ?? null} className="ni-initials">
              <TextInput
                id="ni-initials"
                value={form.value.initials}
                onChange={(e) => form.update({ initials: normaliseInitials(e.target.value) })}
                onBlur={() => form.touch('initials')}
                autoComplete="off"
                spellCheck={false}
                maxLength={60}
              />
            </Field>
          </div>

          <section className="ni-set" aria-labelledby="ni-set-title">
            <div className="ni-set__row">
              <div className="ni-set__text" aria-live="polite">
                <h2 id="ni-set-title" className="ni-label">
                  Questions
                </h2>
                {bank === undefined && !shown.length ? (
                  <p className="ni-set__count muted">Drawing the questions…</p>
                ) : (
                  <>
                    <p className="ni-set__count" data-testid="set-summary">
                      <strong>
                        {shown.length} question{shown.length === 1 ? '' : 's'}
                      </strong>{' '}
                      · about {minutes} min{' '}
                      {over > 0 ? (
                        <span className="ni-over">
                          <Icon name="alert" /> {over} min over the {budgetMin}-minute budget
                        </span>
                      ) : (
                        <span className="muted">of your {budgetMin}</span>
                      )}
                    </p>
                    <p className="ni-set__mix">
                      {reusing ? (
                        <>
                          The same questions as <strong>{reusePlan!.name}</strong>, so the results can be compared.
                        </>
                      ) : (
                        mixInWords(shown)
                      )}
                    </p>
                  </>
                )}
              </div>
              <div className="ni-set__actions">
                <Button id="ni-shuffle" icon="shuffle" onClick={shuffle} disabled={busy}>
                  Shuffle
                </Button>
                <Button id="ni-edit" icon="edit" aria-expanded={editing} aria-controls="set-editor" onClick={() => (editing ? closeEditor() : openEditor())}>
                  Edit questions
                </Button>
                {!editing && (
                  <button type="button" className="pc-linkbtn" id="ni-reuse" onClick={() => setReuseOpen(true)}>
                    {reusing ? 'Choose another earlier set…' : 'Use the same questions as an earlier interview…'}
                  </button>
                )}
              </div>
            </div>
            {short && (
              <p className="ni-note ni-note--warn">
                <Icon name="alert" /> {short}
              </p>
            )}
            {form.attempted && shown.length === 0 && (
              <p className="field__error">
                <Icon name="alert" /> Add at least one question.
              </p>
            )}
            {undo && (
              <p className="ni-note" role="status">
                {undo.message}{' '}
                <button type="button" className="pc-linkbtn" onClick={undoDraw}>
                  Undo
                </button>
              </p>
            )}
            {editing && !reusing && (
              <SetEditor
                questions={selected}
                bank={bank}
                categories={cats}
                budgetText={budgetText}
                budgetError={budget.error}
                onBudget={onBudget}
                onMoveTo={moveQ}
                onRemove={removeQ}
                onToggle={toggleQ}
                onOpen={setDetail}
                quotas={quotas}
                onQuotas={setQuotas}
                drawFrom={drawFrom}
                onDrawFrom={setDrawFrom}
                onRedraw={() => void draw({ message: 'New questions drawn with this mix.' })}
                busy={busy}
                onDone={closeEditor}
              />
            )}
          </section>

          <MoreOptions
            open={moreOpen}
            onToggle={setMoreOpen}
            value={form.value}
            onChange={form.update}
            errors={form.allErrors}
            showErrors={form.attempted}
            storedName={storedName?.trim() ?? ''}
            retentionDays={retentionDays ?? 90}
            defaultRetention={retention}
            advanced={
              reusing
                ? undefined
                : {
                    setName,
                    onSetName,
                    setNameError: setName.trim() ? null : 'Enter a name.',
                    rows: cats.map((c) => ({ category: c, count: 0, defaultWeight: defaults.get(c.id)?.weight ?? null, weightText: weightOf(c), weightError: weightErrors[c.id] })),
                    onWeight,
                    onMustHave,
                    changed: changedCats.length,
                    onReset: resetWeights,
                  }
            }
          />

          <div className="ni-footer">
            <Button type="submit" variant="primary" size="lg" className="ni-continue">
              Continue <Icon name="arrow-right" />
            </Button>
            <Button icon="clock" onClick={openLater} disabled={busy}>
              Save for later
            </Button>
            <span className="small muted">Next: read the consent text to the candidate, then start.</span>
          </div>
          {form.attempted && (problems.length > 0 || error) && (
            <div ref={problemsRef} tabIndex={-1} className="ni-problems">
              <Alert tone="danger" title={error ? error.message : problems.length === 1 ? 'One thing to fix first:' : `${problems.length} things to fix first:`} role="alert">
                <ul>
                  {error?.details.map((d, i) => <li key={`e${i}`}>{d}</li>)}
                  {problems.map((p) => (
                    <li key={p.field}>
                      <button type="button" className="pc-linkbtn" onClick={() => focusProblem(p.field)}>
                        {p.message}
                      </button>
                    </li>
                  ))}
                </ul>
              </Alert>
            </div>
          )}
        </div>
      </form>

      <QuestionDetailDialog
        question={detail}
        categoryName={detail ? (cats.find((c) => c.id === detail.categoryId)?.name ?? '') : ''}
        onClose={() => setDetail(null)}
        extraFooter={
          detail ? (
            <Button variant={ids.includes(detail.id) ? 'default' : 'primary'} icon={ids.includes(detail.id) ? 'x' : 'plus'} onClick={() => toggleQ(detail.id)}>
              {ids.includes(detail.id) ? 'Remove from this interview' : 'Add to this interview'}
            </Button>
          ) : null
        }
      />
      <ScheduleDialog
        open={laterOpen}
        title="Save for later"
        submitLabel="Save for later"
        intro={`${form.input.initials.trim()}. The questions are fixed now; date, interviewers and note can be changed later.`}
        initial={{ date: '', time: '', expected: [form.value.interviewerName, ...(form.value.otherInterviewers ?? [])].map((n) => n.trim()).filter(Boolean), note: '' }}
        onCancel={() => setLaterOpen(false)}
        onSubmit={saveLater}
      />
      <ReuseDialog open={reuseOpen} onClose={() => setReuseOpen(false)} onChoose={chooseReuse} current={reuseId} />
    </>
  );
}

