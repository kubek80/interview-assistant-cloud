import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { acceptProposal, declineProposal, hasPermission, useMe, useProposal, withdrawProposal } from '../../db';
import { draftFromQuestion } from '../../domain/bankEdit';
import { Alert, Button, ConfirmDialog, EmptyState, PageHeader, ReasonDialog, formatDateTime, useDocumentTitle, useToast } from '../../ui';
import { QuestionEditor, type EditorMode } from '../bank/QuestionEditor';
import { OutOfDateBadge, ProposalComparison, ProposalStatusBadge } from './Compare';
import '../../styles/pages/review.css';

/**
 * Route: /proposals/:id. REVIEW-5, REVIEW-6: one proposal with the current and proposed wording side by
 * side. Organisers and administrators accept, edit then accept, or decline; the reviewer who wrote it
 * sees the outcome and can withdraw it while it waits.
 */
export default function ProposalPage() {
  useDocumentTitle('Proposal');
  const { id } = useParams();
  const p = useProposal(id);
  const me = useMe();
  const navigate = useNavigate();
  const { toast } = useToast();
  const [decline, setDecline] = useState(false);
  const [withdraw, setWithdraw] = useState(false);
  const [editor, setEditor] = useState<EditorMode | null>(null);
  const [busy, setBusy] = useState(false);
  const canDecide = hasPermission(me, 'bank.review');

  if (p === undefined) return <PageHeader title="Proposal" />;
  if (p === null) {
    return (
      <>
        <PageHeader title="Proposal not found" />
        <EmptyState title="This proposal does not exist, or it is not yours to see." />
      </>
    );
  }
  const title = p.kind === 'change' ? `Change to question ${p.questionNumber ?? ''}` : 'New question';
  const back = canDecide ? '/reviews' : '/to-review?tab=proposals';
  const open = p.status === 'open';

  const accept = async () => {
    setBusy(true);
    try {
      const r = await acceptProposal(p.id, { confirmOutOfDate: p.outOfDate });
      toast(r.bumped ? `Accepted. The question is now version ${r.version}.` : 'Accepted.', 'success');
      navigate('/reviews');
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Not accepted.', 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="stack-lg">
      <PageHeader
        title={title}
        subtitle={
          <>
            {p.trackName} · proposed by {p.proposedBy.name} on {formatDateTime(p.createdAt)}
          </>
        }
        actions={
          canDecide && open ? (
            <>
              <Button onClick={() => setDecline(true)}>Decline…</Button>
              <Button
                onClick={() =>
                  setEditor({
                    kind: 'accept',
                    proposalId: p.id,
                    question: p.current,
                    // Starts from the proposal; the comparison above shows what changed since it was written.
                    draft: p.proposed,
                    newCategoryName: p.newCategoryName,
                    confirmOutOfDate: p.outOfDate,
                  })
                }
              >
                Edit, then accept…
              </Button>
              <Button variant="primary" icon="check" onClick={accept} disabled={busy}>
                {p.outOfDate ? 'Accept as proposed' : 'Accept'}
              </Button>
            </>
          ) : !canDecide && open ? (
            <Button onClick={() => setWithdraw(true)}>Withdraw…</Button>
          ) : undefined
        }
      />
      <div className="cluster">
        <ProposalStatusBadge status={p.status} />
        {p.outOfDate && <OutOfDateBadge />}
      </div>
      <section className="stack-sm" aria-label="Why">
        <p>
          <strong>Why:</strong> <span className="pre-wrap">{p.reason}</span>
        </p>
        {p.decidedAt && p.status !== 'withdrawn' && (
          <p>
            <strong>{p.status === 'declined' ? 'Declined' : 'Accepted'}</strong> by {p.decidedBy?.name} on {formatDateTime(p.decidedAt)}
            {p.decisionReason ? (
              <>
                : <span className="pre-wrap">{p.decisionReason}</span>
              </>
            ) : (
              '.'
            )}
            {p.resultQuestionId && p.resultVersion && ` The question is now version ${p.resultVersion}.`}
          </p>
        )}
      </section>
      {p.outOfDate && (
        <Alert tone="warning" title={`The question has changed since this was proposed (version ${p.baseVersion} then, version ${p.currentVersion} now).`}>
          <p>The comparison below is against the current wording. Accepting as proposed replaces the newer wording; to keep both, choose “Edit, then accept”.</p>
        </Alert>
      )}
      <ProposalComparison current={p.current ? draftFromQuestion(p.current) : null} proposed={p.proposed} categories={p.categories} newCategoryName={p.newCategoryName} currentLabel={p.outOfDate ? 'Now (changed since)' : 'Now'} />
      {p.outOfDate && p.base && (
        <details>
          <summary>What the reviewer saw (version {p.baseVersion})</summary>
          <ProposalComparison current={draftFromQuestion(p.base)} proposed={p.proposed} categories={p.categories} newCategoryName={p.newCategoryName} currentLabel={`Version ${p.baseVersion}`} />
        </details>
      )}
      <p>
        <Link to={back}>Back to the list</Link>
        {p.resultQuestionId && (
          <>
            {' · '}
            <Link to={`/bank/${p.trackId}`}>Open the track in the question bank</Link>
          </>
        )}
      </p>
      <ReasonDialog
        open={decline}
        title="Decline this proposal?"
        label="Reason (the reviewer sees it)"
        submitLabel="Decline"
        onCancel={() => setDecline(false)}
        onSubmit={async (reason) => {
          await declineProposal(p.id, reason);
          setDecline(false);
          toast('Declined. The reviewer sees your reason.', 'success');
          navigate('/reviews');
        }}
      />
      <ConfirmDialog
        open={withdraw}
        title="Withdraw this proposal?"
        confirmLabel="Withdraw"
        onCancel={() => setWithdraw(false)}
        onConfirm={async () => {
          await withdrawProposal(p.id);
          setWithdraw(false);
          toast('Withdrawn.', 'success');
        }}
      >
        <p>Organisers will no longer see it as waiting.</p>
      </ConfirmDialog>
      <QuestionEditor
        mode={editor}
        trackId={p.trackId}
        categories={p.categories}
        onClose={() => setEditor(null)}
        onSaved={(r) => {
          setEditor(null);
          toast(r?.bumped ? `Accepted with your edits. The question is now version ${r.version}.` : 'Accepted with your edits.', 'success');
          navigate('/reviews');
        }}
      />
    </div>
  );
}
