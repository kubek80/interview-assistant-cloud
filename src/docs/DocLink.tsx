import { createContext, useContext, type ReactNode } from 'react';
import { Link } from 'react-router';
import { Icon } from '../ui/Icon';
import { docHref, getDocPage, reqHelpLabel } from './content';

/**
 * UX-5: while an interview is running, help opens in a new tab so the interview stays on screen
 * (a help link must never be a way out of it).
 */
const HelpInNewTab = createContext(false);
export const HelpInNewTabProvider = HelpInNewTab.Provider;

/**
 * UX-7: contextual help for a requirement. Screens never show requirement ids: this renders a
 * small "?" link whose accessible name says what it explains ("Help: Consent"), opening the docs
 * section where the requirement is defined (highlighted there). `label` overrides the name derived
 * from the section heading.
 */
export function DocLink({ req, label, className }: { req: string; label?: string; className?: string }) {
  const newTab = useContext(HelpInNewTab);
  return (
    <Link
      to={docHref({ req })}
      className={['help-link', 'help-q', className].filter(Boolean).join(' ')}
      aria-label={`Help: ${label ?? reqHelpLabel(req)}${newTab ? ' (opens in a new tab)' : ''}`}
      title={newTab ? 'Opens in a new tab' : undefined}
      target={newTab ? '_blank' : undefined}
      rel={newTab ? 'noopener' : undefined}
    >
      <Icon name="help" />
    </Link>
  );
}

/**
 * Link to a docs page or one of its sections, e.g. <HelpLink slug="04-scoring" section="bands">Bands</HelpLink>.
 * `section` is the slug of a heading (lower-case words joined by "-").
 */
export function HelpLink({ slug, section, children, className }: { slug: string; section?: string; children?: ReactNode; className?: string }) {
  const newTab = useContext(HelpInNewTab);
  return (
    <Link
      to={docHref({ slug, section })}
      className={['help-link', className].filter(Boolean).join(' ')}
      target={newTab ? '_blank' : undefined}
      rel={newTab ? 'noopener' : undefined}
    >
      <Icon name="help" />
      {children ?? getDocPage(slug)?.title ?? 'Help'}
      {newTab && <span className="visually-hidden"> (opens in a new tab)</span>}
    </Link>
  );
}
