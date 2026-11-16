import { cn } from '@/lib/utils';

/**
 * Segmented control sized like the other form controls: h-9 (sm: h-8 for toolbars), text-sm,
 * equal-width options, never stretched by its container.
 */
export function Segmented<T extends string>({
  value,
  onChange,
  options,
  disabled,
  label,
  size = 'default',
  className,
}: {
  value: T;
  onChange: (v: T) => void;
  options: Array<{ value: T; label: string }>;
  disabled?: boolean;
  label: string;
  size?: 'default' | 'sm';
  className?: string;
}) {
  return (
    <div
      role="radiogroup"
      aria-label={label}
      className={cn(
        'bg-muted grid w-fit auto-cols-fr grid-flow-col items-center gap-0.5 justify-self-start rounded-md p-0.5',
        size === 'sm' ? 'h-8' : 'h-9',
        className,
      )}
    >
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          disabled={disabled}
          onClick={() => onChange(o.value)}
          className={cn(
            'h-full rounded-[5px] px-3 text-sm font-medium whitespace-nowrap transition-colors disabled:cursor-not-allowed disabled:opacity-60',
            'focus-visible:ring-ring/50 outline-none focus-visible:ring-[3px]',
            value === o.value ? 'bg-background dark:bg-input text-foreground shadow-xs' : 'text-muted-foreground hover:text-foreground',
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
