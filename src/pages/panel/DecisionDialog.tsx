import { useId, useState, type FormEvent } from 'react';
import { RepoError, recordDecision, type CandidatePanel } from '../../db';
import { Button, Dialog, Field, Icon, Select, TextArea, TextInput } from '../../ui';
import { ChoiceGroup } from '../interview/OverallFields';
import { RUBRIC_LEVELS } from '../../domain/rubric';
import { decisionProblems, medianScores, type DecisionErrors, type DecisionInput } from '../../domain/decision';
import { RECOMMENDATIONS, RECOMMENDATION_LABELS, type PanelDecision, type Recommendation, type Score } from '../../domain/types';
import { formatNames, nameKey } from '../../domain/interviewers';
import '../../styles/pages/panel.css';

function initialInput(panel: CandidatePanel, current: PanelDecision | null, me: string): DecisionInput {
  if (current) return { recommendation: current.recommendation, rationale: current.rationale, participants: [...current.participants], rating: current.rating, scores: { ...current.scores } };
  return { recommendation: null, rationale: '', participants: panel.panelNames.length ? [...panel.panelNames] : me ? [me] : [], rating: null, scores: {} };
}

/**
 * TEAM-9…TEAM-11: record or change the panel decision. Fast for a clear-cut candidate: pick the
 * recommendation, write one sentence, save. Who took part defaults to the panel's names; the agreed
 * rating and agreed question scores are optional and out of the way; agreed scores start empty and
 * "Start from the panel's median" fills them only when pressed. A change asks for a reason.
 */
export function DecisionDialog({ open, onClose, panel, me, onSaved }: { open: boolean; onClose: () => void; panel: CandidatePanel; me: string; onSaved?: (d: PanelDecision) => void }) {
  const current = panel.data.record?.decision ?? null;
  const [v, setV] = useState<DecisionInput>(() => initialInput(panel, current, me));
  const [reason, setReason] = useState('');
  const [extra, setExtra] = useState('');
  const [errors, setErrors] = useState<DecisionErrors & { reason?: string }>({});
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [shownOpen, setShownOpen] = useState(open);
  const formId = useId();
  if (open !== shownOpen) {
    setShownOpen(open);
    if (open) {
      setV(initialInput(panel, current, me));
      setReason('');
      setExtra('');
      setErrors({});
      setFailure(null);
    }
  }
  const plan = panel.data.plan;
  const members = panel.data.entries.filter((e) => !e.hidden && e.session.state === 'submitted' && e.answers?.some((a) => a.score != null && !a.skipped));
  const names = [...panel.panelNames, ...v.participants.filter((p) => !panel.panelNames.some((n) => nameKey(n) === nameKey(p)))];
  const agreedCount = Object.values(v.scores).filter((s) => s != null).length;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const errs: DecisionErrors & { reason?: string } = decisionProblems(v, plan);
    if (current && !reason.trim()) errs.reason = 'Give a reason for the change.';
    setErrors(errs);
    if (Object.keys(errs).length) {
      const first = errs.recommendation ? `${formId}-rec` : errs.rationale ? `${formId}-why` : errs.participants ? `${formId}-who` : `${formId}-reason`;
      document.getElementById(first)?.querySelector<HTMLElement>('input, textarea')?.focus() ?? document.getElementById(first)?.focus();
      return;
    }
    setBusy(true);
    setFailure(null);
    try {
      const d = await recordDecision(panel.data.ref, v, current ? reason : undefined);
      onSaved?.(d);
      onClose();
    } catch (err) {
      setFailure(err instanceof RepoError ? [err.message, ...err.details].join(' ') : 'The panel decision could not be saved.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      wide
      title={current ? 'Change the panel decision' : 'Record the panel decision'}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" type="submit" form={formId} disabled={busy}>
            {current ? 'Save the change' : 'Save panel decision'}
          </Button>
        </>
      }
    >
      <form id={formId} className="stack pd-form" onSubmit={submit} noValidate>
        <p className="small muted pd-form__intro">
          {panel.data.candidate.initials}
          {panel.data.candidate.requisitionId ? ` · ${panel.data.candidate.requisitionId}` : ''} · the panel’s agreed view. Individual scores are not changed.
        </p>
        <ChoiceGroup<Recommendation>
          legend="Agreed recommendation"
          idPrefix={`${formId}-rec`}
          options={RECOMMENDATIONS.map((r) => ({ value: r, label: RECOMMENDATION_LABELS[r] }))}
          value={v.recommendation}
          onChange={(recommendation) => setV({ ...v, recommendation })}
          error={errors.recommendation}
        />
        <Field label="Why" required error={errors.rationale}>
          <TextArea id={`${formId}-why`} rows={3} value={v.rationale} onChange={(e) => setV({ ...v, rationale: e.target.value })} placeholder="One or two sentences on the evidence behind it" />
        </Field>
        <fieldset className="pd-who" id={`${formId}-who`}>
          <legend className="field__label">Who took part</legend>
          <div className="pd-who__names">
            {names.map((n) => (
              <label key={n} className="checkbox pd-who__name">
                <input
                  type="checkbox"
                  checked={v.participants.some((p) => nameKey(p) === nameKey(n))}
                  onChange={(e) => setV({ ...v, participants: e.target.checked ? [...v.participants, n] : v.participants.filter((p) => nameKey(p) !== nameKey(n)) })}
                />
                <span>{n}</span>
              </label>
            ))}
            <span className="pd-who__add">
              <TextInput
                aria-label="Add someone who took part"
                placeholder="Add a name"
                value={extra}
                maxLength={200}
                onChange={(e) => setExtra(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && extra.trim()) {
                    e.preventDefault();
                    if (!v.participants.some((p) => nameKey(p) === nameKey(extra))) setV({ ...v, participants: [...v.participants, extra.trim()] });
                    setExtra('');
                  }
                }}
              />
              <Button
                size="sm"
                variant="ghost"
                icon="plus"
                disabled={!extra.trim()}
                onClick={() => {
                  if (!v.participants.some((p) => nameKey(p) === nameKey(extra))) setV({ ...v, participants: [...v.participants, extra.trim()] });
                  setExtra('');
                }}
              >
                Add
              </Button>
            </span>
          </div>
          {errors.participants && (
            <div className="field__error">
              <Icon name="alert" />
              <span>{errors.participants}</span>
            </div>
          )}
        </fieldset>

        <details className="pd-more" open={v.rating != null || agreedCount > 0 || undefined}>
          <summary>
            Agreed rating and question scores <span className="muted">(optional{agreedCount ? `, ${agreedCount} set` : ''})</span>
          </summary>
          <div className="stack pd-more__body">
            <Field label="Agreed overall rating">
              <Select
                value={v.rating == null ? '' : String(v.rating)}
                onChange={(e) => setV({ ...v, rating: e.target.value ? (Number(e.target.value) as Score) : null })}
                options={[{ value: '', label: 'None' }, ...RUBRIC_LEVELS.map((l) => ({ value: String(l.score), label: `${l.score} · ${l.label}` }))]}
              />
            </Field>
            <div className="pd-scores">
              <div className="spread">
                <p className="field__label">Agreed scores for questions</p>
                <span className="cluster">
                  <Button
                    size="sm"
                    disabled={!members.length}
                    onClick={() => setV({ ...v, scores: { ...v.scores, ...medianScores(plan, members.map((m) => m.answers!)) } })}
                  >
                    Start from the panel’s median
                  </Button>
                  {agreedCount > 0 && (
                    <Button size="sm" variant="ghost" onClick={() => setV({ ...v, scores: {} })}>
                      Clear
                    </Button>
                  )}
                </span>
              </div>
              <p className="small muted">
                Left empty unless you set them. {members.length ? `The median is of ${formatNames(members.map((m) => m.session.interviewer.name))}’s scores.` : 'Nobody has scored questions yet.'}
              </p>
              <ol className="pd-scores__list">
                {plan.questions.map((q, i) => (
                  <li key={q.id} className="pd-scores__row">
                    <span className="pd-scores__q">
                      <span className="tabular muted">Q{i + 1}</span> {q.text}
                    </span>
                    <Select
                      aria-label={`Agreed score for question ${i + 1}`}
                      value={v.scores[q.id] == null ? '' : String(v.scores[q.id])}
                      onChange={(e) => setV({ ...v, scores: { ...v.scores, [q.id]: e.target.value ? (Number(e.target.value) as Score) : null } })}
                      options={[{ value: '', label: '–' }, ...RUBRIC_LEVELS.map((l) => ({ value: String(l.score), label: `${l.score} ${l.label}` }))]}
                    />
                  </li>
                ))}
              </ol>
            </div>
          </div>
        </details>

        {current && (
          <Field label="Reason for the change" required error={errors.reason ?? null}>
            <TextArea id={`${formId}-reason`} rows={2} value={reason} onChange={(e) => setReason(e.target.value)} />
          </Field>
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
