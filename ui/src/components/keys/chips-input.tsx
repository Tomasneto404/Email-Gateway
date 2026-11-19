// Authored by Tomás Neto (TN 2026)
import { X } from 'lucide-react';
import { useState, type KeyboardEvent } from 'react';
import { cn } from '@/lib/utils';

interface Props {
  value: string[];
  onChange: (v: string[]) => void;
  /** returns an error message for an invalid entry, or null */
  validate: (v: string) => string | null;
  label: string;
  placeholder?: string;
  lowercase?: boolean;
  disabled?: boolean;
  id?: string;
}

/** A list of short values as chips: Enter, comma or space adds; Backspace removes the last one. */
export function ChipsInput({ value, onChange, validate, label, placeholder, lowercase = true, disabled, id }: Props) {
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);

  const commit = (raw: string) => {
    const parts = raw
      .split(/[\s,;]+/)
      .map((s) => (lowercase ? s.trim().toLowerCase() : s.trim()))
      .filter(Boolean);
    if (!parts.length) return true;
    for (const p of parts) {
      const problem = validate(p);
      if (problem) {
        setError(`"${p}": ${problem}`);
        return false;
      }
    }
    const next = [...value];
    for (const p of parts) if (!next.includes(p)) next.push(p);
    onChange(next);
    setDraft('');
    setError(null);
    return true;
  };

  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if ((e.key === 'Enter' || e.key === ',' || e.key === ' ') && draft.trim()) {
      e.preventDefault();
      commit(draft);
    } else if (e.key === 'Enter') {
      e.preventDefault();
    } else if (e.key === 'Backspace' && !draft && value.length) {
      onChange(value.slice(0, -1));
    }
  };

  return (
    <div>
      <div
        className={cn(
          'border-input dark:bg-input/30 flex min-h-9 flex-wrap items-center gap-1 rounded-md border bg-transparent px-2 py-1 shadow-xs',
          'focus-within:border-ring focus-within:ring-ring/50 focus-within:ring-[3px]',
          error && 'border-destructive',
          disabled && 'opacity-60',
        )}
      >
        {value.map((v) => (
          <span key={v} className="bg-secondary inline-flex items-center gap-1 rounded px-1.5 py-0.5 font-mono text-xs">
            {v}
            {!disabled && (
              <button type="button" aria-label={`Remove ${v}`} className="hover:text-destructive" onClick={() => onChange(value.filter((x) => x !== v))}>
                <X className="size-3" />
              </button>
            )}
          </span>
        ))}
        <input
          id={id}
          aria-label={label}
          aria-invalid={!!error}
          className="placeholder:text-muted-foreground min-w-40 flex-1 bg-transparent py-0.5 text-sm outline-none"
          placeholder={value.length ? '' : placeholder}
          value={draft}
          disabled={disabled}
          onChange={(e) => {
            setDraft(e.target.value);
            setError(null);
          }}
          onKeyDown={onKey}
          onBlur={() => draft.trim() && commit(draft)}
        />
      </div>
      {error && (
        <p role="alert" className="text-destructive mt-1 text-xs">
          {error}
        </p>
      )}
    </div>
  );
}
