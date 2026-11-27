import { useEffect, useRef, type RefObject } from 'react';
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router';
import { Icon } from '../ui/Icon';
import { useOnline } from '../ui/hooks';
import { MenuButton } from '../ui/MenuButton';
import { signOut, useReviewCounts } from '../db';
import { ROLE_LABELS, type Me } from '../shared/api';

/**
 * The main navigation: only what the signed-in person can use (the server checks it again).
 * REVIEW-1: a question reviewer sees their review list, the question bank and the docs.
 * REVIEW-7: counts of open proposals (organisers, administrators) and open review items (reviewers).
 */
function navFor(me: Me, counts: { openProposals: number; openReviewItems: number } | undefined) {
  const has = (p: string) => me.permissions.includes(p);
  const reviewer = me.role === 'reviewer';
  return [
    { to: '/', label: 'Dashboard', end: true, show: !reviewer, count: 0 },
    { to: '/rounds', label: 'Rounds', show: has('rounds.list'), count: 0 },
    { to: '/to-review', label: 'To review', show: has('reviews.respond'), count: counts?.openReviewItems ?? 0, countLabel: 'to do' },
    { to: '/bank', label: 'Question bank', show: has('bank.read'), count: 0 },
    { to: '/reviews', label: 'Reviews', show: has('bank.review'), count: counts?.openProposals ?? 0, countLabel: 'proposals waiting' },
    { to: '/users', label: 'Users', show: has('users.read'), count: 0 },
    { to: '/admin', label: 'Admin', show: has('audit.read'), count: 0 },
    { to: '/docs', label: 'Docs', show: true, count: 0 },
  ].filter((n) => n.show);
}

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

/** AUTH-1, AUTH-4: who is signed in, and signing out. */
function Account({ me }: { me: Me }) {
  const navigate = useNavigate();
  return (
    <div className="app-account">
      <MenuButton
        variant="ghost"
        label={me.name ?? me.email.split('@')[0]}
        srLabel="(account menu)"
        items={[
          { label: me.email, detail: ROLE_LABELS[me.role], disabled: true, onSelect: () => {} },
          {
            label: 'Sign out',
            icon: 'arrow-right',
            onSelect: () => {
              void signOut()
                .catch(() => {})
                .then(() => navigate('/sign-in', { replace: true }));
            },
          },
        ]}
      />
    </div>
  );
}

export function Layout({ me }: { me: Me }) {
  const online = useOnline();
  const mainRef = useRef<HTMLElement>(null);
  useFocusOnRouteChange(mainRef);
  const counts = useReviewCounts(me.permissions.includes('bank.review') || me.permissions.includes('reviews.respond'));

  return (
    <>
      <a
        className="skip-link"
        href="#main"
        onClick={(e) => {
          // Hash routing: don't let the browser treat #main as a route.
          e.preventDefault();
          mainRef.current?.focus();
        }}
      >
        Skip to main content
      </a>
      <header className="app-header">
        <div className="app-header__inner">
          <Link to="/" className="app-brand">
            <Icon name="note" />
            Interview Assistant
          </Link>
          <nav className="app-nav" aria-label="Main">
            <ul>
              {navFor(me, counts).map((n) => (
                <li key={n.to}>
                  <NavLink to={n.to} end={n.end}>
                    {n.label}
                    {n.count > 0 && (
                      <span className="app-nav__count">
                        {n.count}
                        <span className="visually-hidden"> {n.countLabel}</span>
                      </span>
                    )}
                  </NavLink>
                </li>
              ))}
            </ul>
          </nav>
          <Account me={me} />
        </div>
      </header>
      {!online && (
        <div className="offline-banner" role="status">
          <Icon name="offline" /> You are offline. Changes cannot be saved until the connection is back.
        </div>
      )}
      <main id="main" ref={mainRef} className="app-main" tabIndex={-1}>
        <Outlet />
      </main>
    </>
  );
}
