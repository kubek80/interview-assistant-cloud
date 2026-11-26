import { useEffect, useRef, type RefObject } from 'react';
import { Link, NavLink, Outlet, useLocation } from 'react-router';
import { Icon } from '../ui/Icon';
import { useOnline } from '../ui/hooks';
import { useSession, useSessions } from '../db';

/**
 * FLOW-34: a running or paused interview on this device stays one click away from every screen
 * except the Dashboard (which leads with it) and the interview itself.
 */
function ResumeLink() {
  const sessions = useSessions();
  const { pathname } = useLocation();
  const active = sessions?.find((s) => s.origin === 'local' && (s.state === 'in_progress' || s.state === 'paused'));
  if (!active || pathname === '/' || pathname === `/interview/${active.id}`) return null;
  return (
    <Link to={`/interview/${active.id}`} className="app-resume">
      <Icon name="play" />
      {active.state === 'paused' ? 'Resume interview' : 'Back to interview'}
    </Link>
  );
}

const NAV = [
  { to: '/', label: 'Dashboard', end: true },
  { to: '/bank', label: 'Question bank' },
  { to: '/summary', label: 'Summary' },
  { to: '/admin', label: 'Admin' },
  { to: '/docs', label: 'Docs' },
];

/**
 * A11Y-2: after a route change, focus the new screen's [data-focus-target] or its h1. Pages that
 * render their h1 after loading data are handled by waiting (briefly) for it to appear.
 */
function useFocusOnRouteChange(mainRef: RefObject<HTMLElement | null>) {
  const { pathname } = useLocation();
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    const main = mainRef.current;
    if (!main) return;
    const tryFocus = () => {
      const el = main.querySelector<HTMLElement>('[data-focus-target]') ?? main.querySelector<HTMLElement>('h1');
      if (!el) return false;
      if (!el.hasAttribute('tabindex')) el.setAttribute('tabindex', '-1');
      el.focus({ preventScroll: el.hasAttribute('data-focus-target') });
      if (!el.hasAttribute('data-focus-target')) window.scrollTo(0, 0);
      return true;
    };
    if (tryFocus()) return;
    const obs = new MutationObserver(() => tryFocus() && obs.disconnect());
    obs.observe(main, { childList: true, subtree: true });
    const t = setTimeout(() => obs.disconnect(), 2000);
    return () => {
      obs.disconnect();
      clearTimeout(t);
    };
  }, [pathname, mainRef]);
}

/**
 * UX-5: the id of the interview on screen when it is running or paused, else null. While it is, the
 * main navigation collapses to the app name and one way out, so a stray click cannot leave it.
 */
function useLiveInterviewId(): string | null {
  const { pathname } = useLocation();
  const id = /^\/interview\/([^/]+)$/.exec(pathname)?.[1];
  const session = useSession(id);
  return session && session.origin === 'local' && (session.state === 'in_progress' || session.state === 'paused') ? session.id : null;
}

export function Layout() {
  const online = useOnline();
  const mainRef = useRef<HTMLElement>(null);
  useFocusOnRouteChange(mainRef);
  const liveId = useLiveInterviewId();

  return (
    <>
      <a className="skip-link" href="#main" onClick={(e) => {
        // Hash routing: don't let the browser treat #main as a route.
        e.preventDefault();
        mainRef.current?.focus();
      }}>
        Skip to main content
      </a>
      {liveId ? (
        <header className="app-header app-header--live">
          <div className="app-header__inner">
            <span className="app-brand">
              <Icon name="note" />
              Interview Assistant
            </span>
            <nav className="app-nav app-nav--live" aria-label="Main">
              <Link to="/" className="app-exit" aria-describedby="app-exit-note">
                <Icon name="chevron-left" />
                Exit to dashboard
              </Link>
              <span id="app-exit-note" className="app-exit__note">
                <Icon name="check" /> Saved as you go · resume any time
              </span>
            </nav>
          </div>
        </header>
      ) : (
      <header className="app-header">
        <div className="app-header__inner">
          <Link to="/" className="app-brand">
            <Icon name="note" />
            Interview Assistant
          </Link>
          <nav className="app-nav" aria-label="Main">
            <ul>
              {NAV.map((n) => (
                <li key={n.to}>
                  <NavLink to={n.to} end={n.end}>
                    {n.label}
                  </NavLink>
                </li>
              ))}
            </ul>
          </nav>
          <ResumeLink />
        </div>
      </header>
      )}
      {!online && (
        <div className="offline-banner" role="status">
          <Icon name="offline" /> You are offline. Your work continues to be saved on this device.
        </div>
      )}
      <main id="main" ref={mainRef} className="app-main" tabIndex={-1}>
        <Outlet />
      </main>
    </>
  );
}
