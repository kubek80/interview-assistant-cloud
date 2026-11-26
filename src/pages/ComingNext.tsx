import { Link } from 'react-router';
import { EmptyState, PageHeader, useDocumentTitle } from '../ui';

/**
 * Placeholder for screens of the local app that the hosted version brings back in its next steps
 * (rounds, interviews, scorecards, debrief, summary; transcripts and AI). Their code is kept in the
 * repository for porting; see README "Porting a screen".
 */
export default function ComingNext({ title }: { title: string }) {
  useDocumentTitle(title);
  return (
    <>
      <PageHeader title={title} />
      <EmptyState title="Coming in the next step">
        <p>This part of Interview Assistant is being moved to the shared, signed-in version and is not available yet.</p>
        <p>
          <Link to="/">Go to the start page</Link>
        </p>
      </EmptyState>
    </>
  );
}
