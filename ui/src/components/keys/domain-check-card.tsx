// Authored by Tomás Neto (TN 2026)
import { RefreshCw } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { useDomainCheck } from '@/api/queries';
import { api, call, errorMessage } from '@/api/client';
import { Signal } from '@/components/common/badges';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { fmtAgo } from '@/lib/format';

const TONE = { pass: 'green', warn: 'amber', fail: 'red' } as const;

/** SPF / DMARC / DKIM of the key's sender domain (SENDER_DOMAIN_CHECKS warn or enforce). */
export function DomainCheckCard({ keyId, mode }: { keyId: string; mode: 'warn' | 'enforce' }) {
  const q = useDomainCheck(keyId, true);
  const qc = useQueryClient();
  const recheck = async () => {
    const fresh = await call(api.GET('/admin/keys/{id}/domain-check', { params: { path: { id: keyId }, query: { fresh: '1' } } }));
    qc.setQueryData(['keys', keyId, 'domain-check'], fresh);
  };
  const d = q.data;
  return (
    <Card className="gap-4">
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle>Sender domain</CardTitle>
        <Button size="icon-sm" variant="ghost" aria-label="Check again" onClick={() => void recheck().catch(() => undefined)}>
          <RefreshCw className="size-4" />
        </Button>
      </CardHeader>
      <CardContent className="grid gap-3 text-sm">
        {q.isLoading && <Skeleton className="h-16 w-full" />}
        {q.error && <p className="text-destructive">{errorMessage(q.error)}</p>}
        {d && (
          <>
            <div className="text-secondary-foreground font-mono text-xs">
              {d.domain} · checked {fmtAgo(d.checkedAt)}
            </div>
            {(
              [
                ['SPF', d.spf],
                ['DMARC', d.dmarc],
                ['DKIM', d.dkim],
              ] as const
            ).map(([label, item]) => (
              <div key={label} className="grid gap-0.5">
                <Signal tone={TONE[item.status]} className={item.status === 'fail' ? 'text-destructive' : undefined}>
                  <span className="font-medium">{label}</span>
                </Signal>
                <p className="text-secondary-foreground pl-4 text-xs leading-4">{item.note}</p>
                {item.record && <p className="text-muted-foreground truncate pl-4 font-mono text-xs" title={item.record}>{item.record}</p>}
              </div>
            ))}
            {mode === 'enforce' && !d.ok && <p className="text-warning-foreground text-xs">Going live is blocked until SPF and DMARC pass</p>}
          </>
        )}
      </CardContent>
    </Card>
  );
}
