import { Link, useSearchParams } from 'react-router';
import { useMyReviews, useProposals } from '../db';
import { Button, EmptyState, Meter, PageHeader, buttonClass, formatDate, useDocumentTitle } from '../ui';
import { ProposalCard } from './Reviews';
import '../styles/pages/review.css';

/** Route: /to-review, a question reviewer's start page (REVIEW-7, REVIEW-2, REVIEW-5). */
export default function ToReview() {
  useDocumentTitle('To review');
  const [params, setParams] = useSearchParams();
  const tab = params.get('tab') === 'proposals' ? 'proposals' : 'requests';
  const reviews = useMyReviews();
  const proposals = useProposals('all', true);
  const open = reviews?.filter((r) => r.state === 'open') ?? [];
  const next = open.find((r) => r.done < r.total);
  return (
    <>
      <PageHeader
        title="To review"
        subtitle="Questions you have been asked to look at, and what you have proposed."
        actions={
          next ? (
            <Link className={buttonClass('primary')} to={`/to-review/${next.id}`}>
              Continue reviewing
            </Link>
          ) : (
            <Link className={buttonClass('default')} to="/bank">
              Open the question bank
            </Link>
          )
        }
      />
      <div className="segmented" role="group" aria-label="Show">
        <Button aria-pressed={tab === 'requests'} onClick={() => setParams({}, { replace: true })}>
          Asked of you{reviews ? ` (${open.length})` : ''}
        </Button>
        <Button aria-pressed={tab === 'proposals'} onClick={() => setParams({ tab: 'proposals' }, { replace: true })}>
          My proposals{proposals ? ` (${proposals.length})` : ''}
        </Button>
      </div>
      {tab === 'requests' ? (
        reviews === undefined ? (
          <p className="muted">Loading…</p>
        ) : reviews.length === 0 ? (
          <EmptyState title="Nobody has asked you for a review yet.">
            <p>You can still read the question bank, comment and propose changes or new questions.</p>
          </EmptyState>
        ) : (
          <ul className="rv-list">
            {reviews.map((r) => (
              <li key={r.id} className="rv-card">
                <div className="rv-card__main">
                  <Link to={`/to-review/${r.id}`} className="rv-card__title">
                    {r.trackName}: {r.scopeLabel}
                  </Link>
                  <p className="rv-card__meta">
                    Asked by {r.requestedBy}
                    {r.dueDate ? ` · due ${formatDate(r.dueDate)}` : ''}
                    {r.state === 'closed' ? ' · closed' : ''}
                  </p>
                  {r.note && <p className="small pre-wrap">{r.note}</p>}
                </div>
                <div className="rv-progress">
                  <Meter label="Your progress" value={r.done} max={Math.max(1, r.total)} valueText={`${r.done} of ${r.total} done`} />
                </div>
              </li>
            ))}
          </ul>
        )
      ) : proposals === undefined ? (
        <p className="muted">Loading…</p>
      ) : proposals.length === 0 ? (
        <EmptyState title="You have not proposed anything yet.">
          <p>Open a question in the question bank and choose “Propose a change”, or “Propose a question” for a new one.</p>
        </EmptyState>
      ) : (
        <ul className="rv-list">
          {proposals.map((p) => (
            <ProposalCard key={p.id} p={p} />
          ))}
        </ul>
      )}
    </>
  );
}
