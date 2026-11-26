import { Link } from 'react-router';
import { buttonClass, useDocumentTitle } from '../ui';
import { Icon } from '../ui/Icon';
import '../styles/pages/auth.css';

/** AUTH-2: shown to anyone who is refused, for whatever reason. It says nothing about the app's data. */
export default function NoAccess() {
  useDocumentTitle('No access');
  return (
    <main id="main" className="auth-page">
      <div className="auth-card">
        <p className="auth-brand">
          <Icon name="note" /> Interview Assistant
        </p>
        <h1>You don’t have access</h1>
        <p>This account can’t sign in to Interview Assistant. Ask an administrator to add you, then try again.</p>
        <Link to="/sign-in" className={buttonClass('primary', 'lg')}>
          Sign in with another account
        </Link>
      </div>
    </main>
  );
}
