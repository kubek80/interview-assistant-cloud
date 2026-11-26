import { useId, useState, type FormEvent } from 'react';
import { addComment, useFeedback } from '../../db';
import { Button, Field, TextArea, formatDateTime, useToast } from '../../ui';
import { Icon } from '../../ui/Icon';

/**
 * REVIEW-4: comments on a question and who has marked it as looking good. Plain text only (SEC-2):
 * React renders it as text, never as HTML.
 */
export function Feedback({ questionId, version, requestId, heading = 'h3' }: { questionId: string; version: number; requestId?: string; heading?: 'h2' | 'h3' }) {
  const fb = useFeedback(questionId);
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const { toast } = useToast();
  const id = useId();
  const H = heading;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!text.trim()) return setError('Write a comment first.');
    setBusy(true);
    try {
      await addComment(questionId, text.trim(), requestId);
      setText('');
      setError(null);
      toast('Comment added.', 'success');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The comment was not saved.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="rv-feedback stack" aria-labelledby={id}>
      <H id={id} className="rv-feedback__title">
        Comments
      </H>
      {fb === undefined ? (
        <p className="muted small">Loading…</p>
      ) : (
        <>
          {fb && fb.looksGood.length > 0 && (
            <p className="small">
              <Icon name="check" /> Looks good to {fb.looksGood.map((g) => `${g.mine ? 'you' : g.name}${g.version !== version ? ` (version ${g.version})` : ''}`).join(', ')}
            </p>
          )}
          {fb && fb.comments.length > 0 ? (
            <ol className="rv-comments" aria-label="Comments, oldest first">
              {fb.comments.map((c) => (
                <li key={c.id}>
                  <p className="rv-comments__meta small muted">
                    <strong>{c.mine ? 'You' : c.author}</strong> · <time dateTime={c.createdAt}>{formatDateTime(c.createdAt)}</time>
                    {c.questionVersion !== version && ` · about version ${c.questionVersion}`}
                  </p>
                  <p className="pre-wrap">{c.text}</p>
                </li>
              ))}
            </ol>
          ) : (
            <p className="muted small">No comments yet.</p>
          )}
        </>
      )}
      <form onSubmit={submit} className="stack-sm">
        <Field label="Add a comment" error={error}>
          <TextArea rows={2} value={text} onChange={(e) => setText(e.target.value)} maxLength={4000} />
        </Field>
        <div>
          <Button type="submit" size="sm" disabled={busy}>
            Add comment
          </Button>
        </div>
      </form>
    </section>
  );
}
