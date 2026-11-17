import { cn } from '@/lib/utils';

/**
 * Signal lights. State is a small dot plus plain text; colour lives only in the dot.
 *   solid  = the state is reached        ring = the state is waiting / was stopped before sending
 */
const DOT = {
  gray: 'bg-muted-foreground/60',
  brand: 'bg-brand',
  green: 'bg-positive',
  red: 'bg-destructive',
  amber: 'bg-warning',
} as const;
const RING = {
  gray: 'ring-muted-foreground/70',
  brand: 'ring-brand',
  green: 'ring-positive',
  red: 'ring-destructive',
  amber: 'ring-warning',
} as const;
type Tone = keyof typeof DOT;

export function Dot({ tone = 'gray', hollow, className }: { tone?: Tone; hollow?: boolean; className?: string }) {
  return (
    <span
      aria-hidden
      className={cn('inline-block size-2 shrink-0 rounded-full', hollow ? cn('ring-[1.5px] ring-inset', RING[tone]) : DOT[tone], className)}
    />
  );
}

/** A state: dot + text, no box. */
export function Signal({ tone = 'gray', hollow, children, className }: { tone?: Tone; hollow?: boolean; children: React.ReactNode; className?: string }) {
  return (
    <span className={cn('inline-flex items-center gap-2 whitespace-nowrap', className)}>
      <Dot tone={tone} hollow={hollow} />
      {children}
    </span>
  );
}

/** A quiet tag (role names, sources, flags): hairline box, secondary text, optional signal dot. */
export function Pill({ children, color = 'gray', className, dot }: { children: React.ReactNode; color?: Tone | 'blue' | 'violet'; className?: string; dot?: boolean }) {
  const tone: Tone = color === 'blue' || color === 'violet' ? 'brand' : color;
  const showDot = dot ?? tone !== 'gray';
  return (
    <span className={cn('text-secondary-foreground inline-flex h-5 items-center gap-1.5 rounded-sm border px-1.5 text-xs whitespace-nowrap', className)}>
      {showDot && <Dot tone={tone} className="size-1.5" />}
      {children}
    </span>
  );
}

const STATUS: Record<string, { tone: Tone; hollow?: boolean }> = {
  queued: { tone: 'gray', hollow: true },
  pending_approval: { tone: 'amber', hollow: true },
  sent: { tone: 'green' },
  captured: { tone: 'gray' },
  failed: { tone: 'red' },
  rejected: { tone: 'red', hollow: true },
};
export const STATUS_LABEL: Record<string, string> = {
  queued: 'Queued',
  pending_approval: 'Pending approval',
  sent: 'Sent',
  captured: 'Captured',
  failed: 'Failed',
  rejected: 'Rejected',
};
export function StatusDot({ status }: { status: string }) {
  const s = STATUS[status] ?? { tone: 'gray' as Tone };
  return <Dot tone={s.tone} hollow={s.hollow} />;
}
export function StatusBadge({ status }: { status: string }) {
  const s = STATUS[status] ?? { tone: 'gray' as Tone };
  return (
    <Signal tone={s.tone} hollow={s.hollow} className={status === 'failed' ? 'text-destructive' : undefined}>
      {STATUS_LABEL[status] ?? status}
    </Signal>
  );
}

/** live = real mail leaves (cobalt, the postmark), approval = held for a human, sandbox = captured only. */
const MODE: Record<string, { tone: Tone; hollow?: boolean }> = { live: { tone: 'brand' }, approval: { tone: 'amber', hollow: true }, sandbox: { tone: 'gray', hollow: true } };
export function ModeDot({ mode }: { mode: string }) {
  const m = MODE[mode] ?? { tone: 'gray' as Tone };
  return <Dot tone={m.tone} hollow={m.hollow} />;
}
export function ModeBadge({ mode }: { mode: string }) {
  const m = MODE[mode] ?? { tone: 'gray' as Tone };
  return (
    <Signal tone={m.tone} hollow={m.hollow} className="text-secondary-foreground">
      {mode}
    </Signal>
  );
}

const OUTCOME: Record<string, Tone> = { delivered: 'green', delayed: 'amber', bounced: 'red', complained: 'red' };
export function OutcomeBadge({ outcome }: { outcome: string | null }) {
  if (!outcome) return null;
  return <Signal tone={OUTCOME[outcome] ?? 'gray'}>{outcome}</Signal>;
}
