import { useParams } from 'react-router';
import { useSession, usePlan } from '../db';
import { useDocumentTitle } from '../ui/hooks';
import { CandidateQuestion } from './interview/CandidateQuestion';
import { candidateDisplay } from './interview/logic';
import '../styles/pages/interview.css';

/**
 * Route: /present/:sessionId. Candidate-facing window with NO app chrome (FLOW-11): only the
 * question number and text, following the interviewer's current question live (Dexie liveQuery
 * also reacts to changes made in another window). A neutral message before the start, while paused
 * and after submission. Nothing about key points, red flags, probes, scores or notes is loaded here.
 */
export default function CandidateWindow() {
  const { sessionId } = useParams();
  const session = useSession(sessionId);
  const plan = usePlan(session?.planId);
  useDocumentTitle('Candidate view');
  const loading = session === undefined || (session !== null && plan === undefined);
  return (
    <main className="candidate-window" aria-busy={loading || undefined}>
      {loading ? <h1 className="candidate-question__waiting">Loading…</h1> : <CandidateQuestion display={candidateDisplay(session, plan)} />}
    </main>
  );
}
