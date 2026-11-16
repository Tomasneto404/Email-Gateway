import { Check, Copy, Inbox } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

export function PageHeader({ title, description, actions }: { title: ReactNode; description?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3 border-b px-6 py-4">
      <div className="min-w-0">
        <h1 className="text-lg font-semibold tracking-tight">{title}</h1>
        {description && <p className="text-muted-foreground mt-0.5 text-sm">{description}</p>}
      </div>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </div>
  );
}

export function EmptyState({ title, description, icon, className }: { title: string; description?: string; icon?: ReactNode; className?: string }) {
  return (
    <div className={cn('text-muted-foreground flex flex-col items-center justify-center gap-2 py-14 text-center', className)}>
      <div className="bg-muted rounded-full p-3">{icon ?? <Inbox className="size-5" />}</div>
      <div className="text-foreground text-sm font-medium">{title}</div>
      {description && <div className="max-w-sm text-sm">{description}</div>}
    </div>
  );
}

export function CopyButton({ value, label = 'Copy', className }: { value: string; label?: string; className?: string }) {
  const [done, setDone] = useState(false);
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      className={className}
      onClick={async () => {
        await navigator.clipboard?.writeText(value);
        setDone(true);
        setTimeout(() => setDone(false), 1500);
      }}
    >
      {done ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
      {done ? 'Copied' : label}
    </Button>
  );
}

export function Field({ label, children, hint, error, htmlFor }: { label: ReactNode; children: ReactNode; hint?: ReactNode; error?: string; htmlFor?: string }) {
  return (
    // content-start: rows never stretch, so inputs in the same grid row stay aligned
    // even when only one of the fields has a hint/error underneath.
    <div className="grid min-w-0 content-start gap-1.5">
      <label htmlFor={htmlFor} className="text-sm leading-5 font-medium">
        {label}
      </label>
      {children}
      {error ? <p className="text-destructive text-xs leading-4">{error}</p> : hint ? <p className="text-muted-foreground text-xs leading-4">{hint}</p> : null}
    </div>
  );
}

export function KV({ items }: { items: Array<[ReactNode, ReactNode]> }) {
  return (
    <dl className="grid grid-cols-[minmax(110px,auto)_1fr] gap-x-4 gap-y-2 text-sm">
      {items.map(([k, v], i) => (
        <div key={i} className="contents">
          <dt className="text-muted-foreground">{k}</dt>
          <dd className="min-w-0 break-words">{v}</dd>
        </div>
      ))}
    </dl>
  );
}
