import { useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { createReviewRequest, useProposals, useReviewRequests, useReviewers, useTrackBank, useTracks } from '../db';
import type { ProposalSummary, ReviewRequestSummary } from '../shared/api';
import { Alert, Button, Checkbox, Dialog, EmptyState, Field, Meter, PageHeader, Select, TextArea, TextInput, formatDate, formatDateTime, useDocumentTitle, useToast } from '../ui';
import { OutOfDateBadge, ProposalStatusBadge } from './review/Compare';
import '../styles/pages/review.css';

/** Route: /reviews, for organisers and administrators (REVIEW-5, REVIEW-7). */
export default function Reviews() {
  useDocumentTitle('Reviews');
  const [params, setParams] = useSearchParams();
  const tab = params.get('tab') === 'requests' ? 'requests' : 'proposals';
  const [asking, setAsking] = useState(false);
  const proposals = useProposals(params.get('show') === 'decided' ? 'decided' : 'open');
  const requests = useReviewRequests();
  const set = (patch: Record<string, string | null>) => {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(patch)) (v === null ? next.delete(k) : next.set(k, v));
    setParams(next, { replace: true });
  };
  return (
    <>
      <PageHeader
        title="Reviews"
        subtitle="Proposals from question reviewers, and the reviews you have asked for."
        actions={
          <Button variant="primary" icon="plus" onClick={() => setAsking(true)}>
            Ask for a review
          </Button>
        }
      />
      <div className="segmented" role="group" aria-label="Show">
        <Button aria-pressed={tab === 'proposals'} onClick={() => set({ tab: null })}>
          Proposals{proposals && params.get('show') !== 'decided' ? ` (${proposals.length})` : ''}
        </Button>
        <Button aria-pressed={tab === 'requests'} onClick={() => set({ tab: 'requests' })}>
          Review requests
        </Button>
      </div>
      {tab === 'proposals' ? (
        <section className="stack" aria-label="Proposals">
          <div className="cluster">
            <label className="small" htmlFor="rv-show">
              Show
            </label>
            <Select id="rv-show" className="rv-show" value={params.get('show') === 'decided' ? 'decided' : 'open'} onChange={(e) => set({ show: e.target.value === 'open' ? null : e.target.value })} options={[{ value: 'open', label: 'Waiting for a decision' }, { value: 'decided', label: 'Decided' }]} />
          </div>
          {proposals === undefined ? (
            <p className="muted">Loading…</p>
          ) : proposals.length === 0 ? (
            <EmptyState title={params.get('show') === 'decided' ? 'No decided proposals yet.' : 'No proposals are waiting.'}>
              <p>Question reviewers propose changes from the question bank. Ask for a review to get them started.</p>
            </EmptyState>
          ) : (
            <ul className="rv-list">
              {proposals.map((p) => (
                <ProposalCard key={p.id} p={p} />
              ))}
            </ul>
          )}
        </section>
      ) : (
        <section className="stack" aria-label="Review requests">
          {requests === undefined ? (
            <p className="muted">Loading…</p>
          ) : requests.length === 0 ? (
            <EmptyState title="You have not asked for a review yet." actions={<Button onClick={() => setAsking(true)}>Ask for a review</Button>} />
          ) : (
            <ul className="rv-list">
              {requests.map((r) => (
                <RequestCard key={r.id} r={r} />
              ))}
            </ul>
          )}
        </section>
      )}
      <AskForReview open={asking} onClose={() => setAsking(false)} onCreated={() => set({ tab: 'requests' })} />
    </>
  );
}

export function ProposalCard({ p }: { p: ProposalSummary }) {
  return (
    <li className="rv-card">
      <div className="rv-card__main">
        <Link to={`/proposals/${p.id}`} className="rv-card__title">
          {p.kind === 'change' ? `Change to question ${p.questionNumber}: ` : 'New question: '}
          {p.text}
        </Link>
        <p className="rv-card__meta">
          {p.trackName} · {p.proposedBy.name} · {formatDateTime(p.createdAt)}
        </p>
        <p className="small pre-wrap">{p.reason}</p>
        {p.decisionReason && <p className="small">Decision: {p.decisionReason}</p>}
      </div>
      <div className="cluster">
        <ProposalStatusBadge status={p.status} />
        {p.outOfDate && <OutOfDateBadge />}
      </div>
    </li>
  );
}

function RequestCard({ r }: { r: ReviewRequestSummary }) {
  return (
    <li className="rv-card">
      <div className="rv-card__main">
        <Link to={`/reviews/${r.id}`} className="rv-card__title">
          {r.trackName}: {r.scopeLabel}
        </Link>
        <p className="rv-card__meta">
          {r.total} question{r.total === 1 ? '' : 's'} · asked {formatDate(r.createdAt)}
          {r.dueDate ? ` · due ${formatDate(r.dueDate)}` : ''}
          {r.state === 'closed' ? ' · closed' : ''}
        </p>
      </div>
      <div className="rv-progress">
        {r.reviewers.map((x) => (
          <Meter key={x.id} label={x.name} value={x.done} max={Math.max(1, r.total)} valueText={`${x.done} of ${r.total} done`} />
        ))}
      </div>
    </li>
  );
}

/** REVIEW-7: choose a track, a category or questions, the reviewers, a note and a due date. */
function AskForReview({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: () => void }) {
  const tracks = useTracks();
  const reviewers = useReviewers();
  const { toast } = useToast();
  const [trackId, setTrackId] = useState('');
  const [scope, setScope] = useState<'track' | 'category' | 'questions'>('track');
  const [categoryId, setCategoryId] = useState('');
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [who, setWho] = useState<Set<string>>(new Set());
  const [note, setNote] = useState('');
  const [due, setDue] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const track = trackId || tracks?.[0]?.id || '';
  const bank = useTrackBank(open ? track : undefined);
  const active = useMemo(() => (bank?.questions ?? []).filter((q) => q.status === 'active'), [bank]);
  const visible = active.filter((q) => !search.trim() || q.text.toLowerCase().includes(search.trim().toLowerCase()));

  const submit = async () => {
    setError(null);
    try {
      await createReviewRequest({
        trackId: track,
        scope,
        categoryId: scope === 'category' ? categoryId : undefined,
        questionIds: scope === 'questions' ? [...picked] : undefined,
        reviewerIds: [...who],
        note,
        dueDate: due || undefined,
      });
      toast('Review requested. The reviewers see it in their list when they sign in.', 'success');
      onClose();
      onCreated();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Not sent.');
    }
  };

  return (
    <Dialog open={open} onClose={onClose} wide title="Ask for a review">
      {open && (
        <form
          className="stack"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <Field label="Track">
            <Select data-autofocus value={track} onChange={(e) => (setTrackId(e.target.value), setCategoryId(''), setPicked(new Set()))} options={(tracks ?? []).map((t) => ({ value: t.id, label: t.name }))} />
          </Field>
          <fieldset className="stack-sm">
            <legend className="field__label">What to review</legend>
            <div className="cluster">
              {(['track', 'category', 'questions'] as const).map((s) => (
                <label key={s} className="cluster rv-radio">
                  <input type="radio" name="rv-scope" value={s} checked={scope === s} onChange={() => setScope(s)} />
                  {s === 'track' ? `The whole track (${active.length})` : s === 'category' ? 'One category' : 'Chosen questions'}
                </label>
              ))}
            </div>
          </fieldset>
          {scope === 'category' && (
            <Field label="Category">
              <Select value={categoryId} onChange={(e) => setCategoryId(e.target.value)} placeholder="Choose a category" options={(bank?.categories ?? []).map((c) => ({ value: c.id, label: `${c.name} (${active.filter((q) => q.categoryId === c.id).length})` }))} />
            </Field>
          )}
          {scope === 'questions' && (
            <fieldset className="stack-sm">
              <legend className="field__label">Questions ({picked.size} chosen)</legend>
              <Field label="Find" hideLabel>
                <TextInput type="search" placeholder="Find a question" value={search} onChange={(e) => setSearch(e.target.value)} />
              </Field>
              <div className="rv-pick">
                {visible.map((q) => (
                  <Checkbox
                    key={q.id}
                    label={`${q.number}. ${q.text}`}
                    checked={picked.has(q.id)}
                    onChange={(e) => {
                      const next = new Set(picked);
                      if (e.target.checked) next.add(q.id);
                      else next.delete(q.id);
                      setPicked(next);
                    }}
                  />
                ))}
              </div>
            </fieldset>
          )}
          <fieldset className="stack-sm">
            <legend className="field__label">Reviewers</legend>
            {reviewers === undefined ? (
              <p className="muted small">Loading…</p>
            ) : reviewers.length === 0 ? (
              <Alert tone="info" title="There are no question reviewers yet.">
                <p>An administrator adds them on the Users page with the role “Question reviewer”.</p>
              </Alert>
            ) : (
              <div className="cluster">
                {reviewers.map((r) => (
                  <Checkbox
                    key={r.id}
                    label={r.name === r.email ? r.email : `${r.name} (${r.email})`}
                    checked={who.has(r.id)}
                    onChange={(e) => {
                      const next = new Set(who);
                      if (e.target.checked) next.add(r.id);
                      else next.delete(r.id);
                      setWho(next);
                    }}
                  />
                ))}
              </div>
            )}
          </fieldset>
          <Field label="Note for the reviewers (optional)">
            <TextArea rows={2} value={note} onChange={(e) => setNote(e.target.value)} maxLength={2000} />
          </Field>
          <Field label="Due date (optional)">
            <TextInput type="date" value={due} onChange={(e) => setDue(e.target.value)} />
          </Field>
          {error && <Alert tone="danger" title={error} role="alert" />}
          <div className="pc-dialog-actions">
            <Button onClick={onClose}>Cancel</Button>
            <Button variant="primary" type="submit" disabled={!who.size}>
              Send to {who.size || ''} reviewer{who.size === 1 ? '' : 's'}
            </Button>
          </div>
        </form>
      )}
    </Dialog>
  );
}
