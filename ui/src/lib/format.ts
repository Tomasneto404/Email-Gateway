import { format, formatDistanceToNowStrict } from 'date-fns';

export const fmtBytes = (n: number) =>
  n >= 1024 * 1024 ? `${+(n / 1024 / 1024).toFixed(1)} MB` : n >= 1024 ? `${+(n / 1024).toFixed(1)} KB` : `${n} B`;
export const fmtNum = (n: number) => new Intl.NumberFormat().format(n);
export const fmtDate = (s: string | null | undefined) => (s ? format(new Date(s), 'yyyy-MM-dd HH:mm:ss') : '—');
export const fmtShort = (s: string | null | undefined) => (s ? format(new Date(s), 'MMM d, HH:mm') : '—');
export const fmtAgo = (s: string | null | undefined) => (s ? `${formatDistanceToNowStrict(new Date(s))} ago` : 'never');
