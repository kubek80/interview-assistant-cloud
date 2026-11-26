import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { RepoError, createDraftInterview } from '../db';
import { Alert, PageHeader, useDocumentTitle } from '../ui';

/**
 * Route: /new (FLOW-33, UX-2). Opens the New interview screen with a question set already drawn:
 * picks up a set-up that has nothing typed yet, or starts one, then shows it at /setup/:planId so a
 * reload keeps everything (RES-1). `?reuse=<planId>` starts from an earlier question set (FLOW-9).
 */
export default function NewInterview() {
  useDocumentTitle('New interview');
  const [params] = useSearchParams();
  const reuse = params.get('reuse') ?? undefined;
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    createDraftInterview({ reusePlanId: reuse }).then(
      (r) => navigate(`/setup/${r.planId}`, { replace: true, state: { unmet: r.unmet } }),
      (err: unknown) => setError(err instanceof RepoError ? err.message : 'The questions could not be prepared.'),
    );
  }, [reuse, navigate]);

  return (
    <>
      <PageHeader title="New interview" />
      {error ? (
        <Alert tone="danger" title={error} role="alert">
          <p>
            <Link to="/">Back to the dashboard</Link>
          </p>
        </Alert>
      ) : (
        <p className="muted" aria-busy="true">
          Drawing the questions…
        </p>
      )}
    </>
  );
}
