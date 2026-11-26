import { useEffect, useRef, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router';
import { setItemDone, useMyReview, useTrackBank } from '../../db';
import type { ReviewOutcome } from '../../shared/api';
import { Alert, Button, EmptyState, Meter, PageHeader, formatDate, useDocumentTitle, useToast } from '../../ui';
import { Icon } from '../../ui/Icon';
import { QuestionDetail } from '../bank/QuestionDetail';
import { QuestionEditor, type EditorMode } from '../bank/QuestionEditor';
import { LooksGoodButton } from '../QuestionBank';
import { Feedback } from './Feedback';
import '../../styles/pages/review.css';
import '../../styles/pages/bank.css';

const OUTCOME: Record<ReviewOutcome, string> = { looks_good: 'Looks good', commented: 'Commented', proposed: 'Proposed', nothing_to_add: 'Done' };

/**
 * Route: /to-review/:id. REVIEW-7: a reviewer works through the questions of one request: for each,
 * "Looks good", a comment, a proposed change, or "Nothing to add"; then the next one.
 */
export default function WorkThrough() {
  useDocumentTitle('Review');
  const { id } = useParams();
  const [params, setParams] = useSearchParams();
  const r = useMyReview(id);
  const bank = useTrackBank(r?.trackId);
  const [editor, setEditor] = useState<EditorMode | null>(null);
  const { toast } = useToast();
  const mainRef = useRef<HTMLDivElement>(null);
  const qid = params.get('q');

  const firstOpen = r?.items.find((i) => !i.outcome)?.questionId ?? r?.items[0]?.questionId;
  const currentId = qid && r?.items.some((i) => i.questionId === qid) ? qid : firstOpen;
  const index = r ? r.items.findIndex((i) => i.questionId === currentId) : -1;
  const item = r && index >= 0 ? r.items[index] : null;
  const question = bank?.questions.find((q) => q.id === currentId) ?? null;

  const go = (questionId: string | undefined) => {
    if (!questionId) return;
    setParams({ q: questionId }, { replace: true });
  };
  useEffect(() => {
    // Moving to another question puts the reader at its top (A11Y-2).
    mainRef.current?.querySelector<HTMLElement>('h2')?.focus();
  }, [currentId]);

  if (r === undefined) return <PageHeader title="Review" />;
  if (r === null) {
    return (
      <>
        <PageHeader title="Review not found" />
        <EmptyState title="This review request does not exist, or it was not sent to you." />
      </>
    );
  }
  const nextOpen = (after: number) => r.items.slice(after + 1).find((i) => !i.outcome)?.questionId ?? r.items.find((i, k) => k !== after && !i.outcome)?.questionId;
  const advance = () => go(nextOpen(index) ?? r.items[index + 1]?.questionId);
  const closed = r.state === 'closed';

  return (
    <div className="stack">
      <PageHeader
        title={`${r.trackName}: ${r.scopeLabel}`}
        subtitle={`Asked by ${r.requestedBy}${r.dueDate ? ` · due ${formatDate(r.dueDate)}` : ''}`}
        actions={
          <Link to="/to-review" className="small">
            All my reviews
          </Link>
        }
      />
      {r.note && <p className="pre-wrap">{r.note}</p>}
      <Meter label="Your progress" value={r.done} max={Math.max(1, r.total)} valueText={`${r.done} of ${r.total} done`} />
      {closed && <Alert tone="info" title="This review request is closed. You can still read the questions." />}
      {r.done === r.total && !closed && <Alert tone="success" title="You have been through every question. Thank you." />}
      <div className="rv-work">
        <nav className="rv-work__list" aria-label="Questions to review">
          <ol>
            {r.items.map((i, k) => (
              <li key={i.questionId}>
                <button type="button" aria-current={k === index ? 'true' : undefined} onClick={() => go(i.questionId)}>
                  <span className="rv-work__num">{i.number}</span>
                  <span className="rv-work__text">{i.text.length > 60 ? `${i.text.slice(0, 57)}…` : i.text}</span>
                  <span className="rv-work__state">
                    {i.outcome ? (
                      <>
                        <Icon name="check" /> {OUTCOME[i.outcome]}
                      </>
                    ) : (
                      <span className="muted">To do</span>
                    )}
                  </span>
                </button>
              </li>
            ))}
          </ol>
        </nav>
        <div className="rv-work__main stack" ref={mainRef}>
          {!question || !item ? (
            <p className="muted">Loading the question…</p>
          ) : (
            <>
              <h2 tabIndex={-1}>
                Question {question.number} <span className="small muted">({index + 1} of {r.total})</span>
              </h2>
              {item.outcome && (
                <p className="small">
                  <Icon name="check" /> You marked this: {OUTCOME[item.outcome]}.
                </p>
              )}
              <QuestionDetail question={question} categoryName={bank?.categories.find((c) => c.id === question.categoryId)?.name ?? ''} idPrefix="rv" />
              <Feedback questionId={question.id} version={question.version} requestId={closed ? undefined : r.id} />
              <div className="rv-actions" role="group" aria-label="Your review of this question">
                <div className="cluster">
                  <Button icon="chevron-left" onClick={() => go(r.items[index - 1]?.questionId)} disabled={index <= 0}>
                    Previous
                  </Button>
                </div>
                {!closed && (
                  <div className="cluster">
                    <LooksGoodButton questionId={question.id} requestId={r.id} onDone={advance} />
                    <Button size="sm" icon="edit" onClick={() => setEditor({ kind: 'propose-change', question, requestId: r.id })}>
                      Propose a change…
                    </Button>
                    <Button
                      size="sm"
                      aria-pressed={item.outcome === 'nothing_to_add'}
                      onClick={async () => {
                        await setItemDone(r.id, question.id, item.outcome !== 'nothing_to_add');
                        if (item.outcome !== 'nothing_to_add') advance();
                      }}
                    >
                      Nothing to add
                    </Button>
                  </div>
                )}
                <Button variant="primary" onClick={() => go(r.items[index + 1]?.questionId)} disabled={index >= r.items.length - 1}>
                  Next <Icon name="chevron-right" />
                </Button>
              </div>
            </>
          )}
        </div>
      </div>
      {bank && (
        <QuestionEditor
          mode={editor}
          trackId={r.trackId}
          categories={bank.categories}
          onClose={() => setEditor(null)}
          onSaved={() => {
            setEditor(null);
            toast('Proposal sent. Nothing changes until an organiser accepts it.', 'success');
            advance();
          }}
        />
      )}
    </div>
  );
}
