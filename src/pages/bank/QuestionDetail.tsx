import type { ReactNode } from 'react';
import { Badge, Button, Dialog, DocLink, Icon, ItemText, QuestionTags, formatMinutes } from '../../ui';
import { DIFFICULTY_LABEL, TYPE_LABEL, effectiveDifficulty, rubricFor } from '../../domain/rubric';
import { descriptionOf, type Question } from '../../domain/types';

/** BANK-15: key points and red flags are sentences; a leading label is emphasised (`labels`). */
function ItemList({ title, items, id, req, labels = false, className = '' }: { title: string; items: readonly string[]; id: string; req?: string; labels?: boolean; className?: string }) {
  return (
    <section className={`q-detail__list ${className}`.trim()} aria-labelledby={id}>
      <h3 id={id} className="q-detail__list-title">
        {title} <span className="muted small">({items.length})</span>
        {req && <DocLink req={req} />}
      </h3>
      {items.length ? (
        <ul>
          {items.map((item, i) => (
            <li key={i}>
              <span className="pre-wrap">{labels ? <ItemText text={item} /> : item}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted small">None.</p>
      )}
    </section>
  );
}

/** BANK-2: a question's L, R and P lists and the rubric resolved for it (RUB-1, RUB-2, RUB-6, BANK-15). */
export function QuestionDetail({ question, categoryName, idPrefix = 'qd' }: { question: Question; categoryName: string; idPrefix?: string }) {
  const behavioural = question.type === 'behavioural';
  const levels = rubricFor(question);
  const anyOverride = levels.some((l) => l.overridden);
  const description = descriptionOf(question);
  return (
    <div className="q-detail stack">
      <p className="q-detail__text">{question.text}</p>
      {description && (
        <section className="q-detail__desc" aria-labelledby={`${idPrefix}-desc`}>
          <h3 id={`${idPrefix}-desc`} className="q-detail__desc-title">
            <Icon name="steer" /> Description <span className="small muted">for the interviewer, to steer a candidate who is stuck</span> <DocLink req="BANK-8" />
          </h3>
          <p className="pre-wrap">{description}</p>
        </section>
      )}
      <dl className="q-detail__meta">
        <div>
          <dt>Category</dt>
          <dd>{categoryName}</dd>
        </div>
        <div>
          <dt>Type</dt>
          <dd>{TYPE_LABEL[question.type]}</dd>
        </div>
        <div>
          <dt>Difficulty</dt>
          <dd>
            {DIFFICULTY_LABEL[effectiveDifficulty(question)]}
            {behavioural && <span className="muted"> (behavioural, treated as core)</span>}
          </dd>
        </div>
        <div>
          <dt>Tags</dt>
          <dd>
            <QuestionTags question={question} /> <DocLink req="RUB-6" />
          </dd>
        </div>
        <div>
          <dt>Time estimate</dt>
          <dd>{formatMinutes(question.timeMin)}</dd>
        </div>
        <div>
          <dt>Version</dt>
          <dd>
            {question.version}
            {question.status === 'retired' && (
              <>
                {' '}
                <Badge tone="warning" icon="alert">
                  Retired
                </Badge>
              </>
            )}
          </dd>
        </div>
      </dl>
      <div className="q-detail__lists">
        <ItemList id={`${idPrefix}-l`} title="L · Look for" items={question.lookFor} labels className="q-detail__list--l" />
        <ItemList id={`${idPrefix}-r`} title="R · Red flags" items={question.redFlags} labels className="q-detail__list--r" />
        <ItemList id={`${idPrefix}-p`} title="P · Probes" items={question.probes} className="q-detail__list--p" />
      </div>
      <section aria-labelledby={`${idPrefix}-rubric`}>
        <h3 id={`${idPrefix}-rubric`} className="q-detail__list-title">
          Rubric for this question <DocLink req="RUB-1" />
          {anyOverride && <DocLink req="RUB-2" />}
        </h3>
        <p className="small muted">
          {anyOverride
            ? 'Levels marked “Question-specific” replace the shared description for this question.'
            : 'This question uses the shared 1-4 scale, made concrete by its own L and R lists.'}
        </p>
        <div className="table-wrap">
          <table className="table table--compact q-detail__rubric">
            <caption className="visually-hidden">Rubric levels</caption>
            <thead>
              <tr>
                <th scope="col" className="num">
                  Score
                </th>
                <th scope="col">Label</th>
                <th scope="col">Description</th>
              </tr>
            </thead>
            <tbody>
              {levels.map((l) => (
                <tr key={l.score}>
                  <td className="num">
                    <strong>{l.score}</strong>
                  </td>
                  <th scope="row" className="nowrap">
                    {l.label}
                  </th>
                  <td>
                    <span className="pre-wrap">{l.description}</span>
                    {l.overridden && (
                      <>
                        {' '}
                        <Badge tone="info" icon="edit">
                          Question-specific
                        </Badge>
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

export interface QuestionDetailDialogProps {
  question: Question | null;
  categoryName: string;
  onClose: () => void;
  /** Position within the current list, for previous/next navigation. */
  position?: { index: number; total: number; onPrev: () => void; onNext: () => void };
  extraFooter?: ReactNode;
  /** Shown under the question, e.g. comments (REVIEW-4). */
  below?: ReactNode;
}

export function QuestionDetailDialog({ question, categoryName, onClose, position, extraFooter, below }: QuestionDetailDialogProps) {
  return (
    <Dialog
      open={!!question}
      onClose={onClose}
      wide
      title={question ? `Question ${question.number}` : ''}
      footer={
        <>
          {position && (
            <div className="cluster grow">
              <Button size="sm" icon="chevron-left" onClick={position.onPrev} aria-disabled={position.index <= 0 || undefined}>
                Previous
              </Button>
              <span className="small muted" aria-live="polite">
                {position.index + 1} of {position.total}
              </span>
              <Button size="sm" onClick={position.onNext} aria-disabled={position.index >= position.total - 1 || undefined}>
                Next
              </Button>
            </div>
          )}
          {extraFooter}
          <Button onClick={onClose}>Close</Button>
        </>
      }
    >
      {question && <QuestionDetail key={question.id} question={question} categoryName={categoryName} />}
      {question && below}
    </Dialog>
  );
}
