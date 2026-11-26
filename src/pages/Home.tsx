import { Link } from 'react-router';
import { Card, PageHeader, buttonClass, useDocumentTitle } from '../ui';
import { Icon } from '../ui/Icon';
import type { Me } from '../shared/api';

/** The start page. Step 2 replaces it with the Dashboard of rounds and interviews (ROUND-4). */
export default function Home({ me }: { me: Me }) {
  useDocumentTitle('Home');
  const first = (me.name ?? '').split(/\s+/)[0];
  const admin = me.permissions.includes('users.read');
  return (
    <>
      <PageHeader title={first ? `Welcome, ${first}` : 'Welcome'} />
      <Card as="div" className="home-card">
        <p className="home-card__lead">Hiring rounds and interviews arrive in the next update. You can already use the question bank.</p>
        <div className="cluster">
          <Link to="/bank" className={buttonClass('primary', 'lg')}>
            <Icon name="doc" />
            Open the question bank
          </Link>
          {admin && (
            <Link to="/users" className={buttonClass('default', 'lg')}>
              Manage users
            </Link>
          )}
        </div>
      </Card>
    </>
  );
}
