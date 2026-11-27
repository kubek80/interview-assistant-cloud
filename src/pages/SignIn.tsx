import { useState, type FormEvent } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { devSignIn, googleSignInHref, useAuthOptions, useDevUsers } from '../db';
import { ROLE_LABELS } from '../shared/api';
import { Alert, Button, Field, Select, TextInput, buttonClass, useDocumentTitle } from '../ui';
import { Icon } from '../ui/Icon';
import '../styles/pages/auth.css';

/** Where to return after signing in: a path inside the app only (the server checks it again). */
function safeReturn(value: string | null): string {
  return value && /^\/[A-Za-z0-9\-._~/?=&]*$/.test(value) && !value.startsWith('//') ? value : '/';
}

/** AUTH-1: sign in with Google. AUTH-6: development sign-in, when the server has it switched on. */
export default function SignIn() {
  useDocumentTitle('Sign in');
  const [params] = useSearchParams();
  const returnTo = safeReturn(params.get('returnTo'));
  const options = useAuthOptions();
  return (
    <main id="main" className="auth-page">
      <div className="auth-card">
        <p className="auth-brand">
          <Icon name="note" /> Interview Assistant
        </p>
        <h1>Sign in</h1>
        {options === undefined ? (
          <p className="muted">Loading…</p>
        ) : (
          <>
            {options.google && (
              <a className={buttonClass('primary', 'lg', 'auth-google')} href={googleSignInHref(returnTo)}>
                Sign in with Google
              </a>
            )}
            {!options.google && !options.devSignIn && <Alert tone="warning" title="Sign-in is not set up on this server yet." />}
            {options.devSignIn && <DevSignIn returnTo={returnTo} primary={!options.google} />}
            <p className="small muted">Only people an administrator has added can sign in.</p>
          </>
        )}
      </div>
    </main>
  );
}

function DevSignIn({ returnTo, primary }: { returnTo: string; primary: boolean }) {
  const users = useDevUsers(true);
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!email.trim()) return setError('Choose or type an email address.');
    setBusy(true);
    setError(null);
    try {
      const to = await devSignIn(email.trim(), returnTo);
      navigate(to, { replace: true });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Sign-in failed.';
      if (/does not have access/.test(msg)) navigate('/no-access', { replace: true });
      else setError(msg);
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="auth-dev stack" onSubmit={submit} aria-labelledby="dev-title">
      <h2 id="dev-title">Development sign-in</h2>
      <p className="small muted">For development and tests only. It does not exist on a real installation.</p>
      <div className="auth-dev-help small">
        <p>
          <strong>How to sign in here</strong>
        </p>
        <ul>
          <li>
            First time: type <code>admin@example.test</code> in Email (the administrator in the example settings).{' '}
            <Button type="button" variant="ghost" size="sm" onClick={() => setEmail('admin@example.test')}>
              Use it
            </Button>
          </li>
          <li>
            Other test users are in the list once added: <code>organiser@example.test</code>, <code>interviewer@example.test</code> and{' '}
            <code>reviewer@example.test</code>. An administrator can add more on the Users page.
          </li>
          <li>To be several people at once, sign in as a different user in a private window or another browser profile.</li>
        </ul>
      </div>
      {users && users.length > 0 && (
        <Field label="Test user">
          <Select value={users.some((u) => u.email === email) ? email : ''} onChange={(e) => setEmail(e.target.value)} placeholder="Choose…" options={users.map((u) => ({ value: u.email, label: `${u.name ?? u.email} (${ROLE_LABELS[u.role]})` }))} />
        </Field>
      )}
      <Field label="Email" error={error}>
        <TextInput type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="off" />
      </Field>
      <div>
        <Button type="submit" variant={primary ? 'primary' : 'default'} disabled={busy}>
          Sign in as this user
        </Button>
      </div>
    </form>
  );
}
