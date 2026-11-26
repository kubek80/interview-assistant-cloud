import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { isoDate } from '../../domain/plan';
import { formatNames } from '../../domain/interviewers';
import { Button, Checkbox, DocLink, Field, Icon, TextInput, formatDate } from '../../ui';
import type { CandidateDraft, CandidateErrors } from './candidateDraft';
import { CategoryTable, type CategoryRow } from './CategoryTable';
import { OtherInterviewers } from './OtherInterviewers';

export interface MoreOptionsProps {
  open: boolean;
  onToggle: (open: boolean) => void;
  value: CandidateDraft;
  onChange: (patch: Partial<CandidateDraft>) => void;
  errors: CandidateErrors;
  showErrors: boolean;
  /** This device's interviewer (asked inline on first run instead). */
  storedName: string;
  retentionDays: number;
  defaultRetention: string;
  /** Advanced: the question set's name and FLOW-6 weights; absent when the questions are reused (fixed). */
  advanced?: {
    setName: string;
    onSetName: (v: string) => void;
    setNameError: string | null;
    rows: CategoryRow[];
    onWeight: (id: string, text: string) => void;
    onMustHave: (id: string, v: boolean) => void;
    changed: number;
    onReset: () => void;
  };
}

/**
 * FLOW-33: everything optional, collapsed under "More options" with a one-line summary of what
 * is set: requisition id, more interviewers (PANEL-1), recording or transcription (TR-4), how
 * long to keep the record (PRIV-5) and, under "Advanced", the set's name and category weights
 * and must-have flags (FLOW-6).
 */
export function MoreOptions(p: MoreOptionsProps) {
  const v = p.value;
  const others = (v.otherInterviewers ?? []).map((n) => n.trim()).filter(Boolean);
  const summary: string[] = [];
  if (v.requisitionId.trim()) summary.push(`Requisition ${v.requisitionId.trim()}`);
  if (others.length) summary.push(`with ${formatNames(others)}`);
  if (v.recordingNotice) summary.push('recorded or transcribed');
  summary.push(`record kept until ${formatDate(v.retentionUntil)}`);
  if (p.advanced?.changed) summary.push(`${p.advanced.changed} weight${p.advanced.changed === 1 ? '' : 's'} changed`);
  const mustHave = p.advanced?.rows.filter((r) => r.category.mustHave).map((r) => r.category.name) ?? [];
  if (mustHave.length) summary.push(`must-have: ${mustHave.join(', ')}`);

  return (
    <section className="ni-more" aria-labelledby="ni-more-title">
      <h2 className="visually-hidden" id="ni-more-title">
        More options
      </h2>
      <button type="button" className="ni-more__toggle" aria-expanded={p.open} aria-controls="ni-more-body" onClick={() => p.onToggle(!p.open)}>
        <Icon name="chevron-down" className={`ni-chevron${p.open ? ' ni-chevron--open' : ''}`} />
        <span className="ni-more__label">More options</span>
        <span className="ni-more__summary">{summary.join(' · ')}</span>
      </button>
      <div id="ni-more-body" className="ni-more__body" hidden={!p.open}>
        <div className="ni-grid">
          <Field label="Requisition id" hint="Optional. Groups the panel’s interviews of this candidate." error={p.showErrors ? p.errors.requisitionId : null}>
            <TextInput id="ni-req" value={v.requisitionId} onChange={(e) => p.onChange({ requisitionId: e.target.value.slice(0, 100) })} autoComplete="off" spellCheck={false} />
          </Field>
          <Field label="Keep the record until" hint={`${p.retentionDays} days from today unless you change it.`} error={p.showErrors || v.retentionUntil !== p.defaultRetention ? p.errors.retentionUntil : null}>
            <TextInput id="ni-retention" type="date" min={isoDate(new Date())} value={v.retentionUntil} onChange={(e) => p.onChange({ retentionUntil: e.target.value })} />
          </Field>
        </div>

        <Group title="Interviewers">
          {p.storedName && (
            <p className="small">
              You: <strong>{p.storedName}</strong> <span className="muted">(</span>
              <Link to="/admin?tab=device">change</Link>
              <span className="muted">)</span>
            </p>
          )}
          <OtherInterviewers idPrefix="ni" first={v.interviewerName} value={v.otherInterviewers ?? []} onChange={(otherInterviewers) => p.onChange({ otherInterviewers })} showErrors={p.showErrors} />
        </Group>

        <Group title="Recording">
          <Checkbox
            id="ni-recording"
            checked={v.recordingNotice === true}
            onChange={(e) => p.onChange({ recordingNotice: e.target.checked })}
            label="This interview will be recorded or transcribed"
            description="The candidate is told when you read the consent text. Needed to attach a transcript or recording later."
          />
        </Group>

        {p.advanced && (
          <Group
            title={
              <>
                Advanced <DocLink req="FLOW-6" label="category weights and must-have" />
              </>
            }
          >
            <Field label="Name of the question set" hint="Shown when you reuse or share these questions. No candidate details." error={p.advanced.setNameError}>
              <TextInput id="ni-setname" value={p.advanced.setName} onChange={(e) => p.advanced!.onSetName(e.target.value)} maxLength={300} autoComplete="off" />
            </Field>
            <div className="spread">
              <p className="small muted ni-weights-intro">A higher weight counts a category more in the score. If a must-have category averages below 2, the advisory band is capped.</p>
              <Button size="sm" variant="ghost" onClick={p.advanced.onReset} disabled={p.advanced.changed === 0}>
                Reset to defaults
              </Button>
            </div>
            <CategoryTable rows={p.advanced.rows} selectedTotal={0} showCoverage={false} onWeight={p.advanced.onWeight} onMustHave={p.advanced.onMustHave} />
          </Group>
        )}
      </div>
    </section>
  );
}

function Group({ title, children }: { title: ReactNode; children: ReactNode }) {
  return (
    <div className="ni-group">
      <h3 className="ni-group__title">{title}</h3>
      {children}
    </div>
  );
}
