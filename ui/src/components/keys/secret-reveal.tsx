import { KeyRound, ShieldAlert } from 'lucide-react';
import { CopyButton } from '@/components/common/page';

/** The API key secret, shown exactly once. */
export function SecretReveal({ secret, name }: { secret: string; name: string }) {
  return (
    <div className="grid gap-3">
      <div className="flex gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-amber-900 dark:text-amber-200">
        <ShieldAlert className="mt-0.5 size-4 shrink-0" />
        <div>
          <div className="font-medium">Copy this key now — it will not be shown again.</div>
          Only a hash is stored. If you lose it, rotate the key to get a new one.
        </div>
      </div>
      <div className="bg-muted flex items-center gap-2 rounded-md border p-2">
        <KeyRound className="text-muted-foreground size-4 shrink-0" />
        <code data-testid="api-key-secret" className="min-w-0 flex-1 truncate font-mono text-xs select-all" title={`API key for ${name}`}>
          {secret}
        </code>
        <CopyButton value={secret} />
      </div>
    </div>
  );
}
