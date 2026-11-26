import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { RepoError, duplicatePlan, useSessions, useTrackBank } from '../../db';
import { categoryCoverage, formatCandidateKey, shortFingerprint, timeMeter } from '../../domain/plan';
import type { InterviewPlan } from '../../domain/types';
import { Button, DocLink, EmptyState, Icon, PageHeader, SessionStateBadge, buttonClass, formatDate, formatMinutes, useToast } from '../../ui';
import { QuestionDetailDialog } from '../bank/QuestionDetail';
import { sessionAction } from '../dashboard/logic';
import { useExportPlan } from '../dashboard/planFiles';
import { useKeepHeadingFocus } from './useKeepHeadingFocus';
import { CategoryTable } from './CategoryTable';
import { interviewersLabel } from '../../domain/interviewers';
import { questionMeta } from './logic';

/**
 * FLOW-8, FLOW-9: a question set that has been used (pinned): read-only, with "New interview with
 * these questions" (reuse), export as a file for the panel, and "Copy and change".
 */
export function LockedPlanView({ plan }: { plan: InterviewPlan }) {
  const bank = useTrackBank(plan.trackId);
  const sessions = useSessions();
  const navigate = useNavigate();
  const { toast } = useToast();
  const exportPlan = useExportPlan();
  useKeepHeadingFocus();
  const [detailIndex, setDetailIndex] = useState<number | null>(null);
  const trackName = bank?.track.name ?? plan.trackId;
  const catName = useMemo(() => new Map(plan.categories.map((c) => [c.id, c.name])), [plan.categories]);
  const meter = timeMeter(plan.questions, plan.timeBudgetMin);
  const planSessions = (sessions ?? []).filter((s) => s.planId === plan.id);
  const reuse = () => navigate(`/new?reuse=${plan.id}`);

  const duplicate = async () => {
    try {
      const id = await duplicatePlan(plan.id);
      navigate(`/setup/${id}`);
    } catch (err) {
      toast(err instanceof RepoError ? err.message : 'Could not copy the questions.', 'error');
    }
  };

  const detail = detailIndex !== null ? plan.questions[detailIndex] : null;

  return (
    <>
      <PageHeader
        title={plan.name}
        subtitle={
          <>
            {trackName} · {plan.questions.length} questions · about {formatMinutes(meter.totalMin)} of {plan.timeBudgetMin} · fixed for its interviews
          </>
        }
        actions={
          <>
            <Button variant="primary" icon="plus" onClick={reuse}>
              New interview with these questions
            </Button>
            <Button icon="download" onClick={() => exportPlan(plan.id)}>
              Export file
            </Button>
            <Button icon="copy" variant="ghost" onClick={duplicate}>
              Copy and change
            </Button>
          </>
        }
      />
      <div className="stack-lg">
        <p className="small muted">
          These questions, their order and weights stay fixed for the interviews that use them, so the results can be compared. Comparison code{' '}
          <span className="mono" title={plan.fingerprint ?? ''}>
            {shortFingerprint(plan.fingerprint)}
          </span>
          . <DocLink req="FLOW-9" label="reusing and sharing questions" />
        </p>

        <section aria-labelledby="locked-q">
          <h2 id="locked-q">Questions in interview order</h2>
          <ol className="set-list set-list--static">
            {plan.questions.map((q, i) => (
              <li key={q.id} className="set-row">
                <span className="set-row__pos" aria-hidden="true">
                  {i + 1}
                </span>
                <div className="set-row__body">
                  <button type="button" className="set-row__text" onClick={() => setDetailIndex(i)} aria-haspopup="dialog">
                    <span className="visually-hidden">Question {i + 1}: </span>
                    {q.text}
                  </button>
                  <p className="set-row__meta">{questionMeta(q, catName.get(q.categoryId) ?? '')}</p>
                </div>
              </li>
            ))}
          </ol>
        </section>

        <section aria-labelledby="locked-cat">
          <h2 id="locked-cat">Categories and weights</h2>
          <CategoryTable
            readOnly
            selectedTotal={plan.questions.length}
            rows={categoryCoverage(plan.categories, plan.questions).map(({ category, count }) => ({
              category,
              count,
              defaultWeight: null,
              weightText: String(category.weight),
              weightError: null,
            }))}
          />
        </section>

        <section aria-labelledby="locked-sessions">
          <h2 id="locked-sessions">Interviews with these questions</h2>
          {sessions === undefined ? (
            <p className="muted">Loading…</p>
          ) : planSessions.length === 0 ? (
            <EmptyState title="None on this device yet." actions={<Button onClick={reuse}>New interview with these questions</Button>} />
          ) : (
            <ul className="locked-sessions" role="list">
              {planSessions.map((s) => {
                const a = sessionAction(s);
                return (
                  <li key={s.id} className="locked-session">
                    <span className="dash-candidate">{formatCandidateKey(s.candidate)}</span>
                    <SessionStateBadge state={s.state} />
                    <span className="small muted">
                      {interviewersLabel(s)} · {formatDate(s.createdAt)}
                    </span>
                    <Link to={a.to} className={buttonClass('default', 'sm')}>
                      <Icon name={a.icon} />
                      {a.label}
                      <span className="visually-hidden"> for {formatCandidateKey(s.candidate)}</span>
                    </Link>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      </div>

      <QuestionDetailDialog
        question={detail}
        categoryName={detail ? (catName.get(detail.categoryId) ?? '') : ''}
        onClose={() => setDetailIndex(null)}
        position={
          detailIndex !== null
            ? {
                index: detailIndex,
                total: plan.questions.length,
                onPrev: () => detailIndex > 0 && setDetailIndex(detailIndex - 1),
                onNext: () => detailIndex < plan.questions.length - 1 && setDetailIndex(detailIndex + 1),
              }
            : undefined
        }
      />
    </>
  );
}
