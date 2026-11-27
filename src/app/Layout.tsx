import { useCallback, useEffect, useRef, type RefObject } from 'react';
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router';
import { Icon } from '../ui/Icon';
import { useOnline } from '../ui/hooks';
import { MenuButton } from '../ui/MenuButton';
import { retrySaving, signOut, useLiveRecords, useLiveState, useLiveStatus, useOutbox, useOutboxSnapshot, useReviewCounts } from '../db';
import { useToast } from '../ui/Toast';
import { savingLine } from '../pages/interview/liveModel';
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

/**
 * UX-5: the id of the interview on screen while I am interviewing in it (running or paused, my record
 * not submitted), else null. While it is, the main navigation collapses to the app name and one way out.
 */
function useLiveInterviewId(meId: string): string | null {
  const { pathname } = useLocation();
  const id = /^\/interviews\/([0-9a-f-]{36})\/live$/.exec(pathname)?.[1];
  const live = useLiveState(id);
  const records = useLiveRecords(id);
  if (!id || !live || !records?.mine) return null;
  return (live.state === 'in_progress' || live.state === 'paused') && records.mine.ownerId === meId && records.mine.state === 'draft' ? id : null;
}

/**
 * RES-3, HOST-6: during an interview the header says plainly whether every change is saved, being
 * saved, or kept on this computer while offline. It is not a live region (it changes with every
 * click); going offline and coming back are announced once instead.
 */
function SavingStatus({ id }: { id: string }) {
  const online = useOnline();
  const box = useOutboxSnapshot();
  const connection = useLiveStatus();
  const { announce } = useToast();
  const line = savingLine(box.state, box.pending.length, connection, online);
  // The live connection is back (after a server restart, say): send what waits without waiting for the next retry.
  useEffect(() => {
    if (connection === 'live') retrySaving();
  }, [connection]);
  const wasWarn = useRef(false);
  useEffect(() => {
    const warn = line.tone === 'warn';
    if (warn !== wasWarn.current) announce(warn ? 'You are offline. Your marks are kept on this computer and sent when the connection is back.' : 'Back online. Your changes are being saved.');
    wasWarn.current = warn;
  }, [line.tone, announce]);
  return (
    <span id={id} className={`app-exit__note app-exit__note--${line.tone}`} data-testid="saving">
      <Icon name={line.tone === 'ok' ? 'check' : line.tone === 'warn' ? 'offline' : 'clock'} /> {line.text}
    </span>
  );
}

export function Layout({ me }: { me: Me }) {
  const online = useOnline();
  const mainRef = useRef<HTMLElement>(null);
  useFocusOnRouteChange(mainRef);
  const counts = useReviewCounts(me.permissions.includes('bank.review') || me.permissions.includes('reviews.respond'));
  const liveId = useLiveInterviewId(me.id);
  // HOST-6: changes left unsent by an earlier visit are sent from whichever screen opens first.
  const { toast } = useToast();
  useOutbox(me.id, useCallback((m: string) => toast(m, 'error'), [toast]));

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
              <SavingStatus id="app-exit-note" />
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
      )}
      {!online && !liveId && (
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
