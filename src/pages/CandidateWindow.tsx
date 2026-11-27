import { useParams } from 'react-router';
import { usePresentView } from '../db';
import { useDocumentTitle } from '../ui/hooks';
import { CandidateQuestion } from './interview/CandidateQuestion';
import type { CandidateDisplay } from './interview/logic';
import type { PresentView } from '../shared/api';
import '../styles/pages/interview.css';

/** FLOW-11: what the candidate may see: the panel's question number and text, or a neutral message. */
export function presentDisplay(v: PresentView | null): CandidateDisplay {
  if (!v) return { kind: 'waiting', message: 'There is nothing to show here.' };
  if (v.state === 'planned') return { kind: 'waiting', message: 'The interview will begin shortly.' };
  if (v.state === 'paused') return { kind: 'waiting', message: 'The interview is paused. We will continue shortly.' };
  if (v.state === 'completed') return { kind: 'waiting', message: 'The interview has finished. Thank you.' };
  if (v.position == null || v.text == null) return { kind: 'waiting', message: 'The interview will begin shortly.' };
  return { kind: 'question', position: v.position, total: v.total, text: v.text };
}

/**
 * Route: /interviews/:id/present (FLOW-11, LIVE-7). The candidate-facing window, with no app chrome:
 * only the number and text of the panel's current question, following it live for everyone. It needs
 * sign-in and a place on the round like every screen, and its endpoint returns nothing else (no key
 * points, red flags, probes, scores or notes ever reach this window).
 */
export default function CandidateWindow() {
  const { id } = useParams();
  const view = usePresentView(id);
  useDocumentTitle('Candidate view');
  return (
    <main className="candidate-window" aria-busy={view === undefined || undefined}>
      {view === undefined ? <h1 className="candidate-question__waiting">Loading…</h1> : <CandidateQuestion display={presentDisplay(view)} />}
    </main>
  );
}
