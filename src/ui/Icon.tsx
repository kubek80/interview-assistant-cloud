// Inline SVG icons (no icon fonts or external assets: SEC-1, PRIV-2). Decorative by default;
// pass `label` when the icon is the only content of its control.
const PATHS = {
  check: 'M4 12l5 5L20 6',
  x: 'M6 6l12 12M18 6L6 18',
  flag: 'M5 21V4m0 0h11l-2 4 2 4H5',
  skip: 'M5 5l8 7-8 7V5zm11 0v14',
  alert: 'M12 3l10 18H2L12 3zm0 7v5m0 3v.01',
  info: 'M12 22a10 10 0 100-20 10 10 0 000 20zm0-11v6m0-9v.01',
  clock: 'M12 22a10 10 0 100-20 10 10 0 000 20zm0-15v5l3 3',
  'chevron-left': 'M15 5l-7 7 7 7',
  'chevron-right': 'M9 5l7 7-7 7',
  'chevron-down': 'M5 9l7 7 7-7',
  play: 'M7 4l13 8-13 8V4z',
  pause: 'M7 4h3v16H7zM14 4h3v16h-3z',
  download: 'M12 3v12m0 0l-5-5m5 5l5-5M4 21h16',
  upload: 'M12 21V9m0 0l-5 5m5-5l5 5M4 3h16',
  search: 'M11 19a8 8 0 100-16 8 8 0 000 16zm10 2l-5-5',
  help: 'M12 22a10 10 0 100-20 10 10 0 000 20zm-2.5-13a2.5 2.5 0 115 .5c0 1.5-2.5 2-2.5 3.5m0 3v.01',
  lock: 'M6 11h12v10H6V11zm2 0V7a4 4 0 118 0v4',
  eye: 'M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12zm10 3a3 3 0 100-6 3 3 0 000 6z',
  'eye-off': 'M3 3l18 18M10.6 5.1A10 10 0 0112 5c6 0 10 7 10 7a17 17 0 01-3.2 3.9M6.6 6.6C3.8 8.4 2 12 2 12s4 7 10 7a9.6 9.6 0 004.4-1.1M9.9 9.9a3 3 0 004.2 4.2',
  plus: 'M12 5v14M5 12h14',
  trash: 'M4 7h16M10 11v6m4-6v6M6 7l1 13h10l1-13M9 7V4h6v3',
  edit: 'M4 20h4L20 8l-4-4L4 16v4z',
  note: 'M5 3h10l4 4v14H5V3zm9 0v5h5M8 12h8m-8 4h6',
  circle: 'M12 21a9 9 0 100-18 9 9 0 000 18z',
  dot: 'M12 15a3 3 0 100-6 3 3 0 000 6z',
  external: 'M14 4h6v6m0-6L10 14M18 14v6H4V6h6',
  offline: 'M3 3l18 18M8.5 16.5a5 5 0 017 0M5 13a10 10 0 015.2-2.8M19 13a10 10 0 00-2.4-1.8M2 9.5a15 15 0 014.4-2.8M22 9.5A15 15 0 0011 5.1M12 20v.01',
  window: 'M3 5h18v14H3V5zm0 4h18',
  doc: 'M6 3h9l4 4v14H6V3zm8 0v5h5',
  'arrow-up': 'M12 19V5m0 0l-6 6m6-6l6 6',
  'arrow-down': 'M12 5v14m0 0l-6-6m6 6l6-6',
  copy: 'M9 9h11v11H9V9zM5 15H4V4h11v1',
  archive: 'M3 4h18v4H3V4zm2 4v12h14V8M10 12h4',
  undo: 'M9 14L4 9l5-5M4 9h11a5 5 0 010 10h-3',
  folder: 'M3 6h6l2 2h10v11H3V6z',
  grip: 'M9 5h.01M9 12h.01M9 19h.01M15 5h.01M15 12h.01M15 19h.01',
  shuffle: 'M16 3h5v5M4 20L21 3M21 16v5h-5M15 15l6 6M4 4l5 5',
  'arrow-right': 'M5 12h14m0 0l-6-6m6 6l-6 6',
  minus: 'M5 12h14',
  steer: 'M12 22a10 10 0 100-20 10 10 0 000 20zm4-14l-2.5 5.5L8 16l2.5-5.5L16 8z',
} as const;

export type IconName = keyof typeof PATHS;

export function Icon({ name, label, className }: { name: IconName; label?: string; className?: string }) {
  return (
    <svg
      className={`icon${className ? ` ${className}` : ''}`}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden={label ? undefined : true}
      role={label ? 'img' : undefined}
      aria-label={label}
      focusable="false"
    >
      <path d={PATHS[name]} />
    </svg>
  );
}
