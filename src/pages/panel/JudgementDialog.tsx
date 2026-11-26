import { useId, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { RepoError, amendEnteredJudgement, enterJudgement, type CandidatePanel } from '../../db';
import { Button, Dialog, Field, Icon, TextArea, TextInput } from '../../ui';
import { ChoiceGroup } from '../interview/OverallFields';
import { RUBRIC_LEVELS, scoreLabel } from '../../domain/rubric';
import { judgementProblems, type EnteredJudgementInput, type JudgementErrors } from '../../domain/decision';
import { interviewersOf } from '../../domain/interviewers';
import { attendance } from '../../domain/team';
import { RECOMMENDATIONS, RECOMMENDATION_LABELS, type Recommendation, type Score } from '../../domain/types';
import '../../styles/pages/panel.css';

const EMPTY = (name: string): EnteredJudgementInput => ({ name, rating: null, recommendation: null, rationale: '', scores: {}, notes: {} });

/**
 * TEAM-7, TEAM-8: another interviewer's judgement, typed on their behalf (from paper notes, a call,
 * an e-mail). Name, overall rating, recommendation and rationale are required; question scores and
 * notes are optional, in a grid made for the keyboard: type 1–4 and the next question's score is
 * focused; Tab goes to that question's note. With `correcting`, the judgement is corrected with a reason.
 */
export function JudgementDialog({
  open,
  onClose,
  panel,
  correcting,
  onSaved,
}: {
  open: boolean;
  onClose: () => void;
  panel: CandidatePanel;
  /** The record and its current input, to correct a judgement entered before. */
  correcting?: { sessionId: string; input: EnteredJudgementInput } | null;
  onSaved?: (sessionId: string) => void;
}) {
  const data = panel.data;
  const plan = data.plan;
  const submittedNames = data.records.filter((s) => s.state === 'submitted' && s.id !== correcting?.sessionId).flatMap((s) => interviewersOf(s));
  const suggestions = attendance(data.expected, data.records).toCome;
  const [v, setV] = useState<EnteredJudgementInput>(() => correcting?.input ?? EMPTY(suggestions[0] ?? ''));
  const [reason, setReason] = useState('');
  const [errors, setErrors] = useState<JudgementErrors & { reason?: string }>({});
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [shownOpen, setShownOpen] = useState(open);
  const formId = useId();
  const scoreRefs = useRef<Array<HTMLInputElement | null>>([]);
  if (open !== shownOpen) {
    setShownOpen(open);
    if (open) {
      setV(correcting?.input ?? EMPTY(suggestions[0] ?? ''));
      setReason('');
      setErrors({});
      setFailure(null);
    }
  }
  const scoredCount = plan.questions.filter((q) => v.scores[q.id] != null).length;

  const setScore = (qid: string, raw: string) => {
    const n = Number(raw);
    setV((x) => ({ ...x, scores: { ...x.scores, [qid]: raw && n >= 1 && n <= 4 ? (n as Score) : null } }));
  };
  const onScoreKey = (i: number) => (e: KeyboardEvent<HTMLInputElement>) => {
    const qid = plan.questions[i].id;
    if (/^[1-4]$/.test(e.key) && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      setScore(qid, e.key);
      scoreRefs.current[i + 1]?.focus();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      scoreRefs.current[i + 1]?.focus();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      scoreRefs.current[i - 1]?.focus();
    } else if (e.key === 'Backspace' || e.key === 'Delete' || e.key === '0' || e.key === '-') {
      e.preventDefault();
      setScore(qid, '');
    } else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
    }
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const errs: JudgementErrors & { reason?: string } = judgementProblems(v, plan, submittedNames);
    if (correcting && !reason.trim()) errs.reason = 'Give a reason for the correction.';
    setErrors(errs);
    if (Object.keys(errs).length) {
      const order: Array<[keyof typeof errs, string]> = [
        ['name', `${formId}-name`],
        ['rating', `${formId}-rating`],
        ['recommendation', `${formId}-rec`],
        ['rationale', `${formId}-why`],
        ['reason', `${formId}-reason`],
      ];
      const first = order.find(([k]) => errs[k]);
      if (first) {
        const el = document.getElementById(first[1]);
        (el?.matches('input, textarea') ? el : el?.querySelector<HTMLElement>('input, textarea'))?.focus();
      }
      return;
    }
    setBusy(true);
    setFailure(null);
    try {
      if (correcting) {
        await amendEnteredJudgement(correcting.sessionId, v, reason);
        onSaved?.(correcting.sessionId);
      } else {
        onSaved?.(await enterJudgement(data.ref, v));
      }
      onClose();
    } catch (err) {
      setFailure(err instanceof RepoError ? [err.message, ...err.details].join(' ') : 'The judgement could not be saved.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      wide
      title={correcting ? `Correct ${correcting.input.name}’s judgement` : 'Add another interviewer’s judgement'}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" type="submit" form={formId} disabled={busy}>
            {correcting ? 'Save the correction' : 'Save judgement'}
          </Button>
        </>
      }
    >
      <form id={formId} className="stack jd-form" onSubmit={submit} noValidate>
        <p className="small muted">For someone who scored on paper or did not use the app. It is saved as entered by you on their behalf.</p>
        <Field label="Interviewer" required error={errors.name ?? null} hint={suggestions.length && !correcting ? `Still to come: ${suggestions.join(', ')}` : undefined}>
          <TextInput id={`${formId}-name`} value={v.name} maxLength={200} list={`${formId}-names`} autoComplete="off" onChange={(e) => setV({ ...v, name: e.target.value })} data-autofocus={!v.name || undefined} />
        </Field>
        <datalist id={`${formId}-names`}>
          {suggestions.map((n) => (
            <option key={n} value={n} />
          ))}
        </datalist>
        <ChoiceGroup<Score>
          legend="Their overall rating"
          idPrefix={`${formId}-rating`}
          options={RUBRIC_LEVELS.map((l) => ({ value: l.score, label: `${l.score} · ${l.label}` }))}
          value={v.rating}
          onChange={(rating) => setV({ ...v, rating })}
          error={errors.rating}
        />
        <ChoiceGroup<Recommendation>
          legend="Their recommendation"
          idPrefix={`${formId}-rec`}
          options={RECOMMENDATIONS.map((r) => ({ value: r, label: RECOMMENDATION_LABELS[r] }))}
          value={v.recommendation}
          onChange={(recommendation) => setV({ ...v, recommendation })}
          error={errors.recommendation}
        />
        <Field label="Their rationale" required error={errors.rationale ?? null}>
          <TextArea id={`${formId}-why`} rows={3} value={v.rationale} onChange={(e) => setV({ ...v, rationale: e.target.value })} />
        </Field>

        <details className="jd-grid" open={scoredCount > 0 || undefined}>
          <summary>
            Question scores and notes <span className="muted">(optional{scoredCount ? `, ${scoredCount} of ${plan.questions.length} scored` : ''})</span>
          </summary>
          <p className="small muted jd-grid__hint" id={`${formId}-grid-hint`}>
            Type 1–4: the next question’s score is selected. Tab goes to the note. Questions left empty are left out, like skipped ones. With no question scores, the
            judgement counts for its recommendation but has no percentage and is not part of the panel score.
          </p>
          <div className="table-wrap jd-grid__wrap" role="region" aria-label="Question scores" tabIndex={0}>
            <table className="table table--compact jd-table">
              <thead>
                <tr>
                  <th scope="col" className="num">
                    #
                  </th>
                  <th scope="col">Question</th>
                  <th scope="col">Score</th>
                  <th scope="col">Note</th>
                </tr>
              </thead>
              <tbody>
                {plan.questions.map((q, i) => {
                  const s = v.scores[q.id];
                  return (
                    <tr key={q.id}>
                      <td className="num tabular">{i + 1}</td>
                      <td className="jd-table__q">{q.text}</td>
                      <td className="jd-table__score">
                        <input
                          ref={(el) => {
                            scoreRefs.current[i] = el;
                          }}
                          className="input jd-score"
                          inputMode="numeric"
                          aria-label={`Score for question ${i + 1}`}
                          aria-describedby={`${formId}-grid-hint`}
                          value={s == null ? '' : String(s)}
                          placeholder="–"
                          onKeyDown={onScoreKey(i)}
                          onChange={(e) => setScore(q.id, e.target.value.slice(-1))}
                        />
                        <span className="small muted jd-score__label" aria-hidden="true">
                          {s ? scoreLabel(s) : ''}
                        </span>
                      </td>
                      <td>
                        <input
                          className="input jd-note"
                          aria-label={`Note for question ${i + 1}`}
                          value={v.notes[q.id] ?? ''}
                          maxLength={2000}
                          onChange={(e) => setV({ ...v, notes: { ...v.notes, [q.id]: e.target.value } })}
                        />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </details>
        {correcting && (
          <Field label="Reason for the correction" required error={errors.reason ?? null}>
            <TextArea id={`${formId}-reason`} rows={2} value={reason} onChange={(e) => setReason(e.target.value)} />
          </Field>
        )}
        {errors.scores && (
          <p className="field__error">
            <Icon name="alert" /> {errors.scores}
          </p>
        )}
        {failure && (
          <p className="field__error" role="alert">
            <Icon name="alert" /> {failure}
          </p>
        )}
      </form>
    </Dialog>
  );
}
