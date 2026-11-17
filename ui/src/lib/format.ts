// Authored by Tomás Neto (TN 2026)
import { format, formatDistanceToNowStrict } from 'date-fns';

export const fmtBytes = (n: number) =>
  n >= 1024 * 1024 ? `${+(n / 1024 / 1024).toFixed(1)} MB` : n >= 1024 ? `${+(n / 1024).toFixed(1)} KB` : `${n} B`;
export const fmtNum = (n: number) => new Intl.NumberFormat().format(n);
/** One date shape across the UI: "Nov 17, 14:02"; with seconds where order matters (logs); with the year in detail views. */
export const fmtDate = (s: string | null | undefined) => (s ? format(new Date(s), 'MMM d yyyy, HH:mm:ss') : '—');
export const fmtTime = (s: string | null | undefined) => (s ? format(new Date(s), 'MMM d, HH:mm:ss') : '—');
export const fmtShort = (s: string | null | undefined) => (s ? format(new Date(s), 'MMM d, HH:mm') : '—');
export const fmtAgo = (s: string | null | undefined) => (s ? `${formatDistanceToNowStrict(new Date(s))} ago` : 'never');
