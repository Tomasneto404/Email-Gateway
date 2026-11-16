import { cn } from '@/lib/utils';

const tone = {
  gray: 'bg-muted text-muted-foreground',
  blue: 'bg-blue-500/12 text-blue-700 dark:text-blue-300',
  green: 'bg-emerald-500/12 text-emerald-700 dark:text-emerald-300',
  red: 'bg-red-500/12 text-red-700 dark:text-red-300',
  amber: 'bg-amber-500/15 text-amber-800 dark:text-amber-300',
  violet: 'bg-violet-500/12 text-violet-700 dark:text-violet-300',
} as const;

export function Pill({ children, color = 'gray', className, dot }: { children: React.ReactNode; color?: keyof typeof tone; className?: string; dot?: boolean }) {
  return (
    <span className={cn('inline-flex items-center gap-1.5 rounded-md px-1.5 py-0.5 text-xs font-medium whitespace-nowrap', tone[color], className)}>
      {dot && <span className="size-1.5 rounded-full bg-current" />}
      {children}
    </span>
  );
}

const STATUS: Record<string, keyof typeof tone> = {
  queued: 'blue',
  pending_approval: 'amber',
  sent: 'green',
  captured: 'violet',
  failed: 'red',
  rejected: 'red',
};
export const STATUS_LABEL: Record<string, string> = {
  queued: 'Queued',
  pending_approval: 'Pending approval',
  sent: 'Sent',
  captured: 'Captured',
  failed: 'Failed',
  rejected: 'Rejected',
};
export function StatusBadge({ status }: { status: string }) {
  return (
    <Pill color={STATUS[status] ?? 'gray'} dot>
      {STATUS_LABEL[status] ?? status}
    </Pill>
  );
}

const MODE: Record<string, keyof typeof tone> = { sandbox: 'violet', live: 'green', approval: 'amber' };
export function ModeBadge({ mode }: { mode: string }) {
  return <Pill color={MODE[mode] ?? 'gray'}>{mode}</Pill>;
}

const OUTCOME: Record<string, keyof typeof tone> = { delivered: 'green', delayed: 'amber', bounced: 'red', complained: 'red' };
export function OutcomeBadge({ outcome }: { outcome: string | null }) {
  if (!outcome) return null;
  return <Pill color={OUTCOME[outcome] ?? 'gray'}>{outcome}</Pill>;
}
