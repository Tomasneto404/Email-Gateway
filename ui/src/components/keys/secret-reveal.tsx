// Authored by Tomás Neto (TN 2026)
import { Callout } from '@/components/common/page';
import { Check, ChevronRight, Copy, KeyRound, ShieldAlert, Terminal } from 'lucide-react';
import { useState } from 'react';
import { ModeBadge } from '@/components/common/badges';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { cn } from '@/lib/utils';

function useCopy() {
  const [copied, setCopied] = useState<string | null>(null);
  /** Returns false when the browser refuses clipboard access (e.g. insecure context). */
  const copy = async (id: string, value: string) => {
    try {
      if (!navigator.clipboard) return false;
      await navigator.clipboard.writeText(value);
    } catch {
      return false;
    }
    setCopied(id);
    setTimeout(() => setCopied((c) => (c === id ? null : c)), 1800);
    return true;
  };
  return { copied, copy };
}

interface Props {
  secret: string;
  name: string;
  mode?: string;
  /** shown after a rotation */
  rotated?: boolean;
  /** called when the user confirms (or copies) the key — parents enable "Done" with it */
  onAcknowledgedChange?: (ok: boolean) => void;
}

/**
 * Shows an API key secret exactly once: large, wrapping, select-all block, one-click copy,
 * an env-var/curl helper, and an explicit "I stored it" confirmation before closing.
 */
export function SecretReveal({ secret, name, mode, rotated, onAcknowledgedChange }: Props) {
  const { copied, copy } = useCopy();
  const [ack, setAck] = useState(false);
  const [showUsage, setShowUsage] = useState(false);
  const acknowledge = (v: boolean) => {
    setAck(v);
    onAcknowledgedChange?.(v);
  };
  const [copyFailed, setCopyFailed] = useState(false);
  const doCopy = async (id: string, value: string) => {
    const ok = await copy(id, value);
    setCopyFailed(!ok);
    if (ok) acknowledge(true);
  };
  const origin = typeof window !== 'undefined' ? window.location.origin : '';
  const envVar = `MAIL_GATEWAY_API_KEY=${secret}`;
  const curl = `curl -X POST ${origin}/v1/send \\
  -H "Authorization: Bearer ${secret}" \\
  -H "Content-Type: application/json" \\
  -d '{"to":"someone@example.com","subject":"Hello","text":"Sent through mail-gateway"}'`;

  return (
    // [&>*]:min-w-0 — long content (the curl example) must scroll, never widen the dialog
    <div className="grid min-w-0 gap-4 [&>*]:min-w-0">
      <Callout tone="warn" icon={<ShieldAlert />}>
        <p>
          <span className="font-medium">This is the only time the full key is shown.</span>{' '}
          <span className="text-secondary-foreground">{rotated ? 'The previous secret has stopped working. ' : ''}Store it in your secret manager now; only a hash is kept.</span>
        </p>
      </Callout>

      <div className="grid gap-2">
        <div className="flex items-center justify-between gap-2">
          <span className="flex items-center gap-2 text-sm font-medium">
            <KeyRound className="text-muted-foreground size-4" /> API key for {name}
          </span>
          {mode && <ModeBadge mode={mode} />}
        </div>
        <code
          data-testid="api-key-secret"
          className="bg-muted/60 block rounded-md border px-3 py-2.5 font-mono text-[13px] leading-relaxed tracking-tight break-all select-all"
          onClick={(e) => window.getSelection()?.selectAllChildren(e.currentTarget)}
        >
          {secret}
        </code>
        {copyFailed && <p className="text-destructive text-xs">The browser blocked clipboard access: click the key to select it and copy it manually.</p>}
        <div className="flex flex-wrap gap-2">
          <Button type="button" size="sm" onClick={() => doCopy('key', secret)} data-testid="copy-secret">
            {copied === 'key' ? <Check className="size-4" /> : <Copy className="size-4" />}
            {copied === 'key' ? 'Copied' : 'Copy key'}
          </Button>
          <Button type="button" size="sm" variant="outline" onClick={() => doCopy('env', envVar)}>
            {copied === 'env' ? <Check className="size-4" /> : <Copy className="size-4" />}
            {copied === 'env' ? 'Copied' : 'Copy as env var'}
          </Button>
        </div>
      </div>

      <div className="min-w-0 overflow-hidden rounded-md border">
        <button
          type="button"
          onClick={() => setShowUsage((v) => !v)}
          aria-expanded={showUsage}
          className="hover:bg-accent/50 flex w-full items-center gap-2 px-3 py-2 text-left text-sm"
        >
          <ChevronRight className={cn('text-muted-foreground size-4 transition-transform', showUsage && 'rotate-90')} />
          <Terminal className="text-muted-foreground size-4" /> Try it with curl
        </button>
        {showUsage && (
          <div className="relative border-t">
            <pre className="bg-muted/40 max-w-full overflow-x-auto p-3 pr-20 font-mono text-xs leading-5">{curl}</pre>
            <Button type="button" size="sm" variant="outline" className="absolute top-2 right-2 h-7" onClick={() => doCopy('curl', curl)}>
              {copied === 'curl' ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
              {copied === 'curl' ? 'Copied' : 'Copy'}
            </Button>
          </div>
        )}
      </div>

      <label className="flex cursor-pointer items-center gap-2 text-sm">
        <Checkbox checked={ack} onCheckedChange={(c) => acknowledge(!!c)} aria-label="I have stored this key securely" />
        I have stored this key securely
      </label>
    </div>
  );
}
