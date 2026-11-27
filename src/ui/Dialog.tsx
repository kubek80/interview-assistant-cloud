import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Button, IconButton } from './Button';
import { Field, TextArea } from './Field';

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export interface DialogProps {
  open: boolean;
  /** Called on Esc, the close button, or a footer cancel. The parent sets open=false. */
  onClose: () => void;
  title: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
  /** Role "alertdialog" for confirmations that interrupt the flow. */
  role?: 'dialog' | 'alertdialog';
}

/**
 * Modal dialog on the native <dialog> element (A11Y-1): traps focus, closes on Esc and returns
 * focus to the control that opened it. Put `data-autofocus` on the element to focus first.
 */
export function Dialog({ open, onClose, title, children, footer, wide, role = 'dialog' }: DialogProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  const titleId = useId();
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    const dlg = ref.current;
    if (!dlg) return;
    if (open && !dlg.open) {
      opener.current = document.activeElement as HTMLElement | null;
      dlg.showModal();
      const target = dlg.querySelector<HTMLElement>('[data-autofocus]') ?? dlg.querySelector<HTMLElement>(`.dialog__body ${FOCUSABLE}`) ?? dlg.querySelector<HTMLElement>(FOCUSABLE);
      target?.focus();
    } else if (!open && dlg.open) {
      dlg.close();
    }
    return () => {
      if (!open) return;
      const el = opener.current;
      if (el && el.isConnected) requestAnimationFrame(() => el.focus());
    };
  }, [open]);

  useEffect(() => {
    const dlg = ref.current;
    if (!dlg) return;
    const onCancel = (e: Event) => {
      e.preventDefault();
      onCloseRef.current();
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Tab') return;
      const items = Array.from(dlg.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((el) => el.offsetParent !== null || el === document.activeElement);
      if (!items.length) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    dlg.addEventListener('cancel', onCancel);
    dlg.addEventListener('keydown', onKeyDown);
    return () => {
      dlg.removeEventListener('cancel', onCancel);
      dlg.removeEventListener('keydown', onKeyDown);
    };
  }, []);

  return (
    <dialog ref={ref} className={`dialog${wide ? ' dialog--wide' : ''}`} aria-labelledby={titleId} role={role === 'alertdialog' ? 'alertdialog' : undefined}>
      {open && (
        <div className="dialog__inner">
          <div className="dialog__header">
            <h2 id={titleId} className="dialog__title">
              {title}
            </h2>
            <IconButton icon="x" label="Close" size="sm" onClick={onClose} />
          </div>
          <div className="dialog__body">{children}</div>
          {footer && <div className="dialog__footer">{footer}</div>}
        </div>
      )}
    </dialog>
  );
}

export interface ConfirmDialogProps {
  open: boolean;
  title: ReactNode;
  children?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  /** May be async; the dialog shows a busy state until it settles. */
  onConfirm: () => void | Promise<void>;
  onCancel: () => void;
}

export function ConfirmDialog({ open, title, children, confirmLabel = 'Confirm', cancelLabel = 'Cancel', danger, onConfirm, onCancel }: ConfirmDialogProps) {
  const [busy, setBusy] = useState(false);
  const confirm = async () => {
    setBusy(true);
    try {
      await onConfirm();
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open={open}
      onClose={onCancel}
      title={title}
      role="alertdialog"
      footer={
        <>
          <Button onClick={onCancel} data-autofocus={danger ? true : undefined}>
            {cancelLabel}
          </Button>
          <Button variant={danger ? 'danger' : 'primary'} onClick={confirm} disabled={busy} data-autofocus={danger ? undefined : true}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      {children}
    </Dialog>
  );
}

export interface ReasonDialogProps {
  open: boolean;
  title: ReactNode;
  /** Label of the reason field, e.g. "Reason for skipping". */
  label?: string;
  hint?: ReactNode;
  /** Extra content above the field (e.g. what is about to change). */
  children?: ReactNode;
  submitLabel?: string;
  initialValue?: string;
  onSubmit: (reason: string) => void | Promise<void>;
  onCancel: () => void;
  /** The reason may be left empty (closing a round, ROUND-5). */
  optional?: boolean;
}

/** Asks for a required reason (FLOW-17 skip, AUD-4 amend). */
export function ReasonDialog({ open, title, label = 'Reason', hint, children, submitLabel = 'Save', initialValue = '', onSubmit, onCancel, optional }: ReasonDialogProps) {
  const [reason, setReason] = useState(initialValue);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const formId = useId();

  // Reset the field while rendering the opening frame (not in an effect), so the field never shows
  // the previous reason and text typed straight after opening is not overwritten by a late reset.
  const [shownOpen, setShownOpen] = useState(open);
  if (open !== shownOpen) {
    setShownOpen(open);
    if (open) {
      setReason(initialValue);
      setError(null);
    }
  }

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!reason.trim() && !optional) {
      setError('A reason is required.');
      return;
    }
    setBusy(true);
    try {
      await onSubmit(reason.trim());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onCancel}
      title={title}
      footer={
        <>
          <Button onClick={onCancel}>Cancel</Button>
          <Button variant="primary" type="submit" form={formId} disabled={busy}>
            {submitLabel}
          </Button>
        </>
      }
    >
      <form id={formId} onSubmit={submit} className="stack">
        {children}
        <Field label={label} hint={hint} error={error} required={!optional}>
          <TextArea data-autofocus value={reason} onChange={(e) => setReason(e.target.value)} rows={3} />
        </Field>
      </form>
    </Dialog>
  );
}
