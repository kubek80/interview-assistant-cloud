import { Component, useEffect, type ReactNode } from 'react';
import { HashRouter, Link, Navigate, Route, Routes, useLocation } from 'react-router';
import { QueryClientProvider } from '@tanstack/react-query';
import { Layout } from './Layout';
import { LiveProvider, queryClient, setSignedOutHandler, useMe } from '../db';
import { ToastProvider } from '../ui/Toast';
import { Alert, PageHeader } from '../ui/Card';
import { Button } from '../ui/Button';
import QuestionBank from '../pages/QuestionBank';
import Admin from '../pages/Admin';
import Docs from '../pages/Docs';
import Users from '../pages/Users';
import SignIn from '../pages/SignIn';
import NoAccess from '../pages/NoAccess';
import Home from '../pages/Home';
import ComingNext from '../pages/ComingNext';
import type { Me } from '../shared/api';

function NotFound() {
  return (
    <>
      <PageHeader title="Page not found" />
      <p>
        <Link to="/">Go to the start page</Link>
      </p>
    </>
  );
}

/** A screen for one permission only; others see a plain message (the server refuses them anyway). */
function Only({ permission, me, children }: { permission: string; me: Me; children: ReactNode }) {
  if (me.permissions.includes(permission)) return <>{children}</>;
  return (
    <>
      <PageHeader title="Not available" />
      <p>
        This page is for administrators. <Link to="/">Go to the start page</Link>
      </p>
    </>
  );
}

/** Shows a plain message instead of a blank page when loading data fails. */
class ErrorBoundary extends Component<{ children: ReactNode; resetKey: string }, { error: Error | null }> {
  override state: { error: Error | null } = { error: null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  override componentDidUpdate(prev: { resetKey: string }) {
    if (prev.resetKey !== this.props.resetKey && this.state.error) this.setState({ error: null });
  }
  override render() {
    if (!this.state.error) return this.props.children;
    return (
      <main className="app-main" id="main">
        <PageHeader title="Something went wrong" />
        <Alert tone="danger" title={this.state.error.message || 'This page could not be loaded.'}>
          <p>Check your connection and try again.</p>
        </Alert>
        <p>
          <Button
            onClick={() => {
              void queryClient.resetQueries();
              this.setState({ error: null });
            }}
          >
            Try again
          </Button>
        </p>
      </main>
    );
  }
}

/** Everything except sign-in and no-access needs a signed-in person (AUTH-1). */
function SignedInApp() {
  const me = useMe();
  const location = useLocation();
  useEffect(() => {
    // A request that finds the session gone (signed out elsewhere, deactivated, expired) signs the page out.
    setSignedOutHandler(() => queryClient.setQueryData(['me'], null));
    return () => setSignedOutHandler(null);
  }, []);
  if (me === undefined) {
    return (
      <main className="app-loading" aria-busy="true">
        <p className="muted">Loading…</p>
      </main>
    );
  }
  if (me === null) return <Navigate to={`/sign-in?returnTo=${encodeURIComponent(location.pathname + location.search)}`} replace />;
  return (
    <LiveProvider>
      <Routes>
        <Route element={<Layout me={me} />}>
          <Route index element={<Home me={me} />} />
          <Route path="bank" element={<QuestionBank />} />
          <Route path="bank/:trackId" element={<QuestionBank />} />
          <Route
            path="users"
            element={
              <Only permission="users.read" me={me}>
                <Users me={me} />
              </Only>
            }
          />
          <Route
            path="admin"
            element={
              <Only permission="audit.read" me={me}>
                <Admin />
              </Only>
            }
          />
          <Route path="docs" element={<Docs />} />
          <Route path="docs/:slug" element={<Docs />} />
          {/* Steps 2 and 3 of the hosted build: the routes exist so links keep working. */}
          <Route path="new" element={<ComingNext title="New interview" />} />
          <Route path="plan" element={<ComingNext title="Plan several interviews" />} />
          <Route path="setup/:planId" element={<ComingNext title="Interview set-up" />} />
          <Route path="interview/:sessionId" element={<ComingNext title="Interview" />} />
          <Route path="scorecard/:sessionId" element={<ComingNext title="Scorecard" />} />
          <Route path="debrief/:sessionId" element={<ComingNext title="Debrief" />} />
          <Route path="compare" element={<ComingNext title="Compare candidates" />} />
          <Route path="summary" element={<ComingNext title="Summary" />} />
          <Route path="candidate/:ref" element={<ComingNext title="Candidate" />} />
          <Route path="present/:sessionId" element={<ComingNext title="Candidate window" />} />
          <Route path="*" element={<NotFound />} />
        </Route>
      </Routes>
    </LiveProvider>
  );
}

function Routed() {
  const location = useLocation();
  return (
    <ErrorBoundary resetKey={location.pathname}>
      <Routes>
        <Route path="/sign-in" element={<SignIn />} />
        <Route path="/no-access" element={<NoAccess />} />
        <Route path="/*" element={<SignedInApp />} />
      </Routes>
    </ErrorBoundary>
  );
}

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <HashRouter>
          <Routed />
        </HashRouter>
      </ToastProvider>
    </QueryClientProvider>
  );
}
