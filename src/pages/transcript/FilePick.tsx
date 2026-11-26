import { useRef } from 'react';
import { Button, type IconName } from '../../ui';

/**
 * A button that opens the file picker (the input itself is hidden and out of the tab order, so
 * focus is always on a visible control: A11Y-1). `inputLabel` names the hidden input for tests
 * and assistive tech.
 */
export function FilePick({
  label,
  inputLabel,
  accept,
  onFile,
  disabled,
  icon = 'upload',
  size = 'sm',
  variant,
}: {
  label: string;
  inputLabel: string;
  accept: string;
  onFile: (file: File) => void;
  disabled?: boolean;
  icon?: IconName;
  size?: 'sm' | 'md';
  variant?: 'default' | 'primary' | 'ghost';
}) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <>
      <input
        ref={input}
        type="file"
        accept={accept}
        className="visually-hidden"
        tabIndex={-1}
        aria-label={inputLabel}
        disabled={disabled}
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = '';
          if (f) onFile(f);
        }}
      />
      <Button size={size} variant={variant} icon={icon} disabled={disabled} onClick={() => input.current?.click()}>
        {label}
      </Button>
    </>
  );
}
