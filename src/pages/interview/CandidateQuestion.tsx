import type { CandidateDisplay } from './logic';

/** Renders a CandidateDisplay. The heading is the screen's h1 (A11Y-2). */
export function CandidateQuestion({ display }: { display: CandidateDisplay }) {
  return (
    <div className="candidate-question" aria-live="polite" aria-atomic="true">
      {display.kind === 'question' ? (
        <>
          <h1 className="candidate-question__number" tabIndex={-1}>
            Question {display.position} <span className="candidate-question__of">of {display.total}</span>
          </h1>
          <p className="question-text question-text--candidate candidate-question__text">{display.text}</p>
        </>
      ) : (
        <h1 className="candidate-question__waiting" tabIndex={-1}>
          {display.message}
        </h1>
      )}
    </div>
  );
}
