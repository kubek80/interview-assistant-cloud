import { DIFFICULTY_LABEL, DIFFICULTY_TAG, TYPE_LABEL, TYPE_TAG } from '../../domain/rubric';
import { DIFFICULTIES, QUESTION_TYPES } from '../../domain/types';
import { DocLink } from '../../ui';

/** RUB-6 legend for the tag letters. */
export function TagLegend() {
  return (
    <details className="tag-legend">
      <summary className="small">What do the tags mean?</summary>
      <div className="tag-legend__body small">
        <p>
          Difficulty:{' '}
          {DIFFICULTIES.map((d) => (
            <span key={d} className="nowrap">
              <span className="tag">{DIFFICULTY_TAG[d]}</span> {DIFFICULTY_LABEL[d].toLowerCase()}{' '}
            </span>
          ))}
        </p>
        <p>
          Type:{' '}
          {QUESTION_TYPES.map((t) => (
            <span key={t} className="nowrap">
              <span className="tag">{TYPE_TAG[t]}</span> {TYPE_LABEL[t].toLowerCase()}{' '}
            </span>
          ))}
        </p>
        <p>
          Behavioural questions carry no difficulty tag and are treated as core. <DocLink req="RUB-6" />
        </p>
      </div>
    </details>
  );
}
