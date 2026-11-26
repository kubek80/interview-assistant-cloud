export { formatPct, formatAverage, formatCoverage } from '../domain/scoring';

/** "mm:ss", or "h:mm:ss" from one hour. Negative values clamp to 0. */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const ss = String(s).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${String(m).padStart(2, '0')}:${ss}`;
}

export const formatSeconds = (sec: number) => formatDuration(sec * 1000);

/** Spoken form for aria-labels, e.g. "12 minutes 5 seconds". */
export function formatDurationLong(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const parts = [h && `${h} hour${h === 1 ? '' : 's'}`, m && `${m} minute${m === 1 ? '' : 's'}`, (s || (!h && !m)) && `${s} second${s === 1 ? '' : 's'}`];
  return parts.filter(Boolean).join(' ');
}

const dateFmt = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' });
const dateTimeFmt = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });

/** Accepts an ISO timestamp or a YYYY-MM-DD date (treated as a local calendar day). */
export function formatDate(value: string | null | undefined): string {
  if (!value) return '–';
  const d = /^\d{4}-\d{2}-\d{2}$/.test(value) ? new Date(`${value}T00:00:00`) : new Date(value);
  return Number.isNaN(d.getTime()) ? value : dateFmt.format(d);
}

export function formatDateTime(value: string | null | undefined): string {
  if (!value) return '–';
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? value : dateTimeFmt.format(d);
}

/** "3 min", "1 h 5 min" */
export function formatMinutes(min: number): string {
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m ? `${h} h ${m} min` : `${h} h`;
}
