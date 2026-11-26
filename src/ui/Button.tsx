import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { Icon, type IconName } from './Icon';

export type ButtonVariant = 'default' | 'primary' | 'danger' | 'ghost';
export type ButtonSize = 'sm' | 'md' | 'lg';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  icon?: IconName;
  /** Shortcut hint shown after the label, e.g. "N" (rendered as <kbd>, hidden from AT). */
  shortcut?: string;
  children?: ReactNode;
}

export function buttonClass(variant: ButtonVariant = 'default', size: ButtonSize = 'md', extra?: string): string {
  return ['btn', variant !== 'default' && `btn--${variant}`, size !== 'md' && `btn--${size}`, extra].filter(Boolean).join(' ');
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'default', size = 'md', icon, shortcut, className, children, type = 'button', ...rest },
  ref,
) {
  return (
    <button ref={ref} type={type} className={buttonClass(variant, size, className)} aria-keyshortcuts={shortcut} {...rest}>
      {icon && <Icon name={icon} />}
      {children}
      {shortcut && (
        <kbd className="kbd" aria-hidden="true">
          {shortcut}
        </kbd>
      )}
    </button>
  );
});

export interface IconButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> {
  icon: IconName;
  /** Accessible name (also used as the tooltip). Required: the button has no visible text. */
  label: string;
  size?: 'sm' | 'md';
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { icon, label, size = 'md', className, type = 'button', ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      className={['icon-btn', size === 'sm' && 'icon-btn--sm', className].filter(Boolean).join(' ')}
      aria-label={label}
      title={label}
      {...rest}
    >
      <Icon name={icon} />
    </button>
  );
});
