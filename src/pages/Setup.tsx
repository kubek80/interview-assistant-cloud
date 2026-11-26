import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router';
import { getCandidateDraft, usePlan } from '../db';
import type { InterviewPlan } from '../domain/types';
import { loadLegacyCandidateDraft, type CandidateDraft } from './setup/candidateDraft';
import { EmptyState, PageHeader, useDocumentTitle } from '../ui';
import { NewInterviewScreen } from './setup/NewInterviewScreen';
import { LockedPlanView } from './setup/LockedPlanView';
import '../styles/pages/bank.css';
import '../styles/pages/setup.css';

/**
 * Route: /setup/:planId (FLOW-2..9, FLOW-33). A draft is the New interview screen (the same one
 * /new opens); a pinned question set is shown read-only, with reuse and export.
 */
export default function Setup() {
  const { planId } = useParams();
  const plan = usePlan(planId);
  useDocumentTitle(plan?.locked ? 'Question set' : 'New interview');

  if (plan === undefined) {
    return (
      <>
        <PageHeader title="New interview" />
        <p className="muted">Loading…</p>
      </>
    );
  }
  if (plan === null) {
    return (
      <>
        <PageHeader title="Not found" />
        <EmptyState title="These questions are not on this device.">
          <p>They may have been deleted, or set up on another device.</p>
          <p>
            <Link to="/">Go to the dashboard</Link>
          </p>
        </EmptyState>
      </>
    );
  }
  return plan.locked ? <LockedPlanView key={plan.id} plan={plan} /> : <DraftLoader key={plan.id} plan={plan} />;
}

/** Loads the draft's saved candidate details (RES-1) before the screen starts from them. */
function DraftLoader({ plan }: { plan: InterviewPlan }) {
  const [initial, setInitial] = useState<Partial<CandidateDraft> | null | undefined>(undefined);
  useEffect(() => {
    let live = true;
    getCandidateDraft(plan.id)
      .catch(() => null)
      .then((saved) => {
        if (live) setInitial(saved ?? loadLegacyCandidateDraft(plan.id));
      });
    return () => {
      live = false;
    };
  }, [plan.id]);
  if (initial === undefined) {
    return (
      <>
        <PageHeader title="New interview" />
        <p className="muted">Loading…</p>
      </>
    );
  }
  return <NewInterviewScreen plan={plan} initialCandidate={initial} />;
}
