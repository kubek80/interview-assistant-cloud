import { cloneElement, forwardRef, useId, type InputHTMLAttributes, type ReactElement, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from 'react';
import { Icon } from './Icon';

interface FieldProps {
  label: ReactNode;
  hint?: ReactNode;
  error?: string | null;
  required?: boolean;
  /** Hide the label visually but keep it for assistive tech. */
  hideLabel?: boolean;
  className?: string;
  /** A single TextInput / TextArea / Select; it receives id, aria-describedby, aria-invalid, required. */
  children: ReactElement<Record<string, unknown>>;
}

/** Labelled form field with hint and error, wired up for assistive tech (A11Y-2). */
export function Field({ label, hint, error, required, hideLabel, className, children }: FieldProps) {
  const id = useId();
  const controlId = (children.props.id as string | undefined) ?? `${id}-control`;
  const hintId = hint ? `${id}-hint` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  const describedBy = [children.props['aria-describedby'], hintId, errorId].filter(Boolean).join(' ') || undefined;
  return (
    <div className={['field', className].filter(Boolean).join(' ')}>
      <label htmlFor={controlId} className={hideLabel ? 'visually-hidden' : 'field__label'}>
        {label}
        {required && (
          <span className="field__required" aria-hidden="true">
            *
          </span>
        )}
      </label>
      {hint && (
        <div id={hintId} className="field__hint">
          {hint}
        </div>
      )}
      {cloneElement(children, {
        id: controlId,
        'aria-describedby': describedBy,
        'aria-invalid': error ? true : undefined,
        required: required || undefined,
      })}
      {error && (
        <div id={errorId} className="field__error">
          <Icon name="alert" />
          <span>{error}</span>
        </div>
      )}
    </div>
  );
}

export const TextInput = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function TextInput({ className, type = 'text', ...rest }, ref) {
  return <input ref={ref} type={type} className={['input', className].filter(Boolean).join(' ')} {...rest} />;
});

export const TextArea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(function TextArea({ className, ...rest }, ref) {
  return <textarea ref={ref} className={['textarea', className].filter(Boolean).join(' ')} {...rest} />;
});

export interface SelectOption {
  value: string;
  label: string;
  disabled?: boolean;
}

export interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  options?: SelectOption[];
  /** Adds a first option with an empty value. */
  placeholder?: string;
}

export const Select = forwardRef<HTMLSelectElement, SelectProps>(function Select({ className, options, placeholder, children, ...rest }, ref) {
  return (
    <select ref={ref} className={['select', className].filter(Boolean).join(' ')} {...rest}>
      {placeholder !== undefined && <option value="">{placeholder}</option>}
      {options?.map((o) => (
        <option key={o.value} value={o.value} disabled={o.disabled}>
          {o.label}
        </option>
      ))}
      {children}
    </select>
  );
});

export interface CheckboxProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> {
  label: ReactNode;
  description?: ReactNode;
}

/** Checkbox with its label as the click target (≥24px, A11Y-6). */
export const Checkbox = forwardRef<HTMLInputElement, CheckboxProps>(function Checkbox({ label, description, className, disabled, ...rest }, ref) {
  return (
    <label className={['checkbox', disabled && 'checkbox--disabled', className].filter(Boolean).join(' ')}>
      <input ref={ref} type="checkbox" disabled={disabled} {...rest} />
      <span>
        {label}
        {description && <span className="checkbox__description">{description}</span>}
      </span>
    </label>
  );
});
