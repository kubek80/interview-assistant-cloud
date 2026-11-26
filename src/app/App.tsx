import { useEffect, useState } from 'react';
import { HashRouter, Link, Route, Routes } from 'react-router';
import { Layout } from './Layout';
import { initDatabase } from '../db';
import { ToastProvider } from '../ui/Toast';
import { Alert, PageHeader } from '../ui/Card';
import Dashboard from '../pages/Dashboard';
import QuestionBank from '../pages/QuestionBank';
import Setup from '../pages/Setup';
import NewInterview from '../pages/NewInterview';
import LiveInterview from '../pages/LiveInterview';
import CandidateWindow from '../pages/CandidateWindow';
import Scorecard from '../pages/Scorecard';
import Debrief from '../pages/Debrief';
import Comparison from '../pages/Comparison';
import Admin from '../pages/Admin';
import Docs from '../pages/Docs';
import PlanSeveral from '../pages/PlanSeveral';
import Summary from '../pages/Summary';
import CandidateSummary from '../pages/CandidateSummary';

function NotFound() {
  return (
    <>
      <PageHeader title="Page not found" />
      <p>
        <Link to="/">Go to the dashboard</Link>
      </p>
    </>
  );
}

/** Opens the database, loads seeds and purges expired sessions before any screen renders. */
function useDatabaseReady(): { ready: boolean; error: string | null } {
  const [state, setState] = useState<{ ready: boolean; error: string | null }>({ ready: false, error: null });
  useEffect(() => {
    initDatabase().then(
      () => setState({ ready: true, error: null }),
      (err: unknown) => setState({ ready: false, error: err instanceof Error ? err.message : String(err) }),
    );
  }, []);
  return state;
}

export function App() {
  const { ready, error } = useDatabaseReady();
  if (error) {
    return (
      <main className="app-error">
        <h1>Interview Assistant could not start</h1>
        <Alert tone="danger" title="The local database could not be opened.">
          <p>This browser may be blocking storage (for example in a private window). Details: {error}</p>
        </Alert>
      </main>
    );
  }
  if (!ready) {
    return (
      <main className="app-loading" aria-busy="true">
        <p className="muted">Loading…</p>
      </main>
    );
  }
  return (
    <ToastProvider>
      <HashRouter>
        <Routes>
          <Route path="/present/:sessionId" element={<CandidateWindow />} />
          <Route element={<Layout />}>
            <Route index element={<Dashboard />} />
            <Route path="bank" element={<QuestionBank />} />
            <Route path="bank/:trackId" element={<QuestionBank />} />
            <Route path="new" element={<NewInterview />} />
            <Route path="plan" element={<PlanSeveral />} />
            <Route path="setup/:planId" element={<Setup />} />
            <Route path="interview/:sessionId" element={<LiveInterview />} />
            <Route path="scorecard/:sessionId" element={<Scorecard />} />
            <Route path="debrief/:sessionId" element={<Debrief />} />
            <Route path="compare" element={<Comparison />} />
            <Route path="summary" element={<Summary />} />
            <Route path="candidate/:ref" element={<CandidateSummary />} />
            <Route path="admin" element={<Admin />} />
            <Route path="docs" element={<Docs />} />
            <Route path="docs/:slug" element={<Docs />} />
            <Route path="*" element={<NotFound />} />
          </Route>
        </Routes>
      </HashRouter>
    </ToastProvider>
  );
}
