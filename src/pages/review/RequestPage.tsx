import { useState } from 'react';
import { Link, useParams } from 'react-router';
import { closeReviewRequest, useReviewRequest } from '../../db';
import { ConfirmDialog, EmptyState, Meter, PageHeader, Button, formatDate, useDocumentTitle, useToast } from '../../ui';
import { ProposalCard } from '../Reviews';
import '../../styles/pages/review.css';

/** Route: /reviews/:id. REVIEW-7: how far each reviewer has got, and what they proposed. */
export default function RequestPage() {
  useDocumentTitle('Review request');
  const { id } = useParams();
  const r = useReviewRequest(id);
  const { toast } = useToast();
  const [closing, setClosing] = useState(false);
  if (r === undefined) return <PageHeader title="Review request" />;
  if (r === null) {
    return (
      <>
        <PageHeader title="Review request not found" />
        <EmptyState title="This review request does not exist." />
      </>
    );
  }
  return (
    <div className="stack-lg">
      <PageHeader
        title={`${r.trackName}: ${r.scopeLabel}`}
        subtitle={`${r.total} question${r.total === 1 ? '' : 's'} · asked by ${r.requestedBy} on ${formatDate(r.createdAt)}${r.dueDate ? ` · due ${formatDate(r.dueDate)}` : ''}${r.state === 'closed' ? ' · closed' : ''}`}
        actions={r.state === 'open' ? <Button onClick={() => setClosing(true)}>Close request…</Button> : undefined}
      />
      {r.note && (
        <p className="pre-wrap">
          <strong>Note:</strong> {r.note}
        </p>
      )}
      <section className="stack" aria-labelledby="rq-progress">
        <h2 id="rq-progress">Progress</h2>
        <div className="table-wrap">
          <table className="table">
            <caption className="visually-hidden">Progress per reviewer</caption>
            <thead>
              <tr>
                <th scope="col">Reviewer</th>
                <th scope="col">Done</th>
                <th scope="col" className="num">
                  Proposals
                </th>
                <th scope="col" className="num">
                  Comments
                </th>
              </tr>
            </thead>
            <tbody>
              {r.reviewers.map((x) => (
                <tr key={x.id}>
                  <th scope="row">{x.name}</th>
                  <td>
                    <Meter label={`Progress of ${x.name}`} value={x.done} max={Math.max(1, r.total)} valueText={`${x.done} of ${r.total}`} />
                  </td>
                  <td className="num">{x.proposals}</td>
                  <td className="num">{x.comments}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      <section className="stack" aria-labelledby="rq-proposals">
        <h2 id="rq-proposals">Proposed in this review</h2>
        {r.proposals.length ? (
          <ul className="rv-list">
            {r.proposals.map((p) => (
              <ProposalCard key={p.id} p={p} />
            ))}
          </ul>
        ) : (
          <p className="muted">Nothing proposed yet.</p>
        )}
      </section>
      <p>
        <Link to="/reviews?tab=requests">Back to review requests</Link>
      </p>
      <ConfirmDialog
        open={closing}
        title="Close this review request?"
        confirmLabel="Close request"
        onCancel={() => setClosing(false)}
        onConfirm={async () => {
          await closeReviewRequest(r.id);
          setClosing(false);
          toast('Closed. Reviewers no longer see it as something to do.', 'success');
        }}
      >
        <p>Proposals and comments already made stay.</p>
      </ConfirmDialog>
    </div>
  );
}
