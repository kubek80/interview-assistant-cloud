import type { HTMLAttributes, ReactNode } from 'react';
import { Icon, type IconName } from './Icon';

export interface CardProps extends Omit<HTMLAttributes<HTMLElement>, 'title'> {
  title?: ReactNode;
  /** Heading level for the title (default 2). */
  level?: 2 | 3 | 4;
  actions?: ReactNode;
  muted?: boolean;
  as?: 'section' | 'div' | 'article';
}

export function Card({ title, level = 2, actions, muted, as: As = 'section', className, children, ...rest }: CardProps) {
  const H = `h${level}` as 'h2' | 'h3' | 'h4';
  return (
    <As className={['card', muted && 'card--muted', className].filter(Boolean).join(' ')} {...rest}>
      {(title || actions) && (
        <div className="card__header">
          {title && <H className="card__title">{title}</H>}
          {actions && <div className="cluster">{actions}</div>}
        </div>
      )}
      {children}
    </As>
  );
}

const ALERT_ICON: Record<AlertTone, IconName> = { info: 'info', success: 'check', warning: 'alert', danger: 'alert' };
type AlertTone = 'info' | 'success' | 'warning' | 'danger';

/** Inline message box. Use role="alert" only for errors that appear after user action. */
export function Alert({ tone = 'info', title, children, role }: { tone?: AlertTone; title?: ReactNode; children?: ReactNode; role?: 'alert' | 'status' }) {
  return (
    <div className={`alert alert--${tone}`} role={role}>
      <Icon name={ALERT_ICON[tone]} />
      <div className="alert__body">
        {title && <p className="alert__title">{title}</p>}
        {children}
      </div>
    </div>
  );
}

export function EmptyState({ title, children, actions }: { title: ReactNode; children?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="empty-state">
      <p className="empty-state__title">{title}</p>
      {children}
      {actions && <div className="empty-state__actions">{actions}</div>}
    </div>
  );
}

/** Standard page heading row: the screen's single h1 (A11Y-2) plus optional actions. */
export function PageHeader({ title, subtitle, actions }: { title: ReactNode; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="page-header">
      <div>
        <h1 tabIndex={-1}>{title}</h1>
        {subtitle && <p className="page-header__sub">{subtitle}</p>}
      </div>
      {actions && <div className="cluster no-print">{actions}</div>}
    </div>
  );
}
