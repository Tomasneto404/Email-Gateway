import { ExternalLink, ImageOff, Image as ImageIcon } from 'lucide-react';
import { useState } from 'react';
import { useMessage } from '@/api/queries';
import { ModeBadge, OutcomeBadge, Pill, StatusBadge } from '@/components/common/badges';
import { KV } from '@/components/common/page';
import { Button } from '@/components/ui/button';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { fmtBytes, fmtDate } from '@/lib/format';

/**
 * HTML body in a fully sandboxed iframe (no scripts, opaque origin). The preview endpoint adds a
 * strict CSP that blocks all network access; remote images only load when the user opts in.
 */
export function HtmlPreviewFrame({ id }: { id: string }) {
  const [remote, setRemote] = useState(false);
  return (
    <div className="grid gap-2">
      <div className="flex items-center justify-between">
        <span className="text-muted-foreground text-xs">{remote ? 'Remote images are loaded (may notify the sender).' : 'Remote images blocked.'}</span>
        <Button size="sm" variant="outline" onClick={() => setRemote((r) => !r)}>
          {remote ? <ImageOff className="size-3.5" /> : <ImageIcon className="size-3.5" />}
          {remote ? 'Block remote images' : 'Load remote images'}
        </Button>
      </div>
      <iframe
        key={String(remote)}
        title="HTML preview"
        data-testid="html-preview"
        sandbox=""
        referrerPolicy="no-referrer"
        src={`/admin/messages/${id}/preview?remoteImages=${remote ? 1 : 0}`}
        className="h-[420px] w-full rounded-md border bg-white"
      />
    </div>
  );
}

function Timeline({ events }: { events: Array<{ id: string; type: string; fromStatus: string | null; toStatus: string | null; at: string; detail: Record<string, unknown> | null }> }) {
  return (
    <ol className="relative grid gap-3 border-l pl-4">
      {events.map((e) => (
        <li key={e.id} className="relative">
          <span className={`absolute top-1.5 -left-[21px] size-2.5 rounded-full border-2 border-background ${e.type === 'attempt' ? 'bg-amber-500' : e.type === 'provider_event' ? 'bg-sky-500' : 'bg-primary'}`} />
          <div className="flex flex-wrap items-center gap-2 text-sm">
            {e.type === 'status' && e.toStatus ? <StatusBadge status={e.toStatus} /> : <Pill>{e.type === 'attempt' ? 'Attempt failed' : String(e.detail?.type ?? e.type)}</Pill>}
            <span className="text-muted-foreground text-xs">{fmtDate(e.at)}</span>
          </div>
          {e.detail && Object.keys(e.detail).length > 0 && (
            <pre className="bg-muted mt-1 max-h-32 overflow-auto rounded p-2 font-mono text-[11px] whitespace-pre-wrap">{JSON.stringify(e.detail, null, 2)}</pre>
          )}
        </li>
      ))}
    </ol>
  );
}

export function MessageDrawer({ id, onClose }: { id: string | undefined; onClose: () => void }) {
  const { data: m, isLoading } = useMessage(id);
  return (
    <Sheet open={!!id} onOpenChange={(o) => !o && onClose()}>
      <SheetContent className="w-full gap-0 overflow-y-auto sm:max-w-2xl">
        <SheetHeader className="border-b">
          <SheetTitle className="pr-6">{m?.subject || (isLoading ? 'Loading…' : '(no subject)')}</SheetTitle>
          <SheetDescription className="font-mono text-xs">{id}</SheetDescription>
          {m && (
            <div className="flex flex-wrap gap-2 pt-1">
              <StatusBadge status={m.status} />
              <ModeBadge mode={m.deliveryMode} />
              {m.provider && <Pill>{m.provider}</Pill>}
              <OutcomeBadge outcome={m.deliveryOutcome} />
              {m.source === 'admin_test' && <Pill color="blue">test</Pill>}
            </div>
          )}
        </SheetHeader>
        {!m ? (
          <div className="grid gap-2 p-4">
            <Skeleton className="h-4 w-2/3" />
            <Skeleton className="h-4 w-1/2" />
          </div>
        ) : (
          <Tabs defaultValue="overview" className="p-4">
            <TabsList>
              <TabsTrigger value="overview">Overview</TabsTrigger>
              <TabsTrigger value="body">Body</TabsTrigger>
              <TabsTrigger value="timeline">Timeline</TabsTrigger>
              <TabsTrigger value="headers">Headers</TabsTrigger>
            </TabsList>
            <TabsContent value="overview" className="grid gap-4 pt-3">
              {m.rejectCode && (
                <div className="border-destructive/30 bg-destructive/5 rounded-md border p-3 text-sm">
                  <div className="text-destructive font-mono text-xs font-semibold">{m.rejectCode}</div>
                  <div className="mt-1">{m.rejectReason}</div>
                </div>
              )}
              <KV
                items={[
                  ['Key', m.apiKey.name],
                  ['From', m.fromName ? `${m.fromName} <${m.fromAddress}>` : m.fromAddress],
                  ['To', m.to.join(', ') || '—'],
                  ...(m.cc.length ? ([['Cc', m.cc.join(', ')]] as Array<[string, string]>) : []),
                  ...(m.bcc.length ? ([['Bcc', m.bcc.join(', ')]] as Array<[string, string]>) : []),
                  ...(m.replyTo ? ([['Reply-To', m.replyTo]] as Array<[string, string]>) : []),
                  ['Created', fmtDate(m.createdAt)],
                  ['Sent', fmtDate(m.sentAt)],
                  ['Attempts', String(m.attempts)],
                  ['Size', fmtBytes(m.sizeBytes)],
                  ['Source IP', m.sourceIp ?? '—'],
                  ['Last error', m.lastError ?? '—'],
                  ['Provider response', <span className="font-mono text-xs">{m.providerResponse ?? '—'}</span>],
                  ['Provider id', <span className="font-mono text-xs">{m.providerMessageId ?? '—'}</span>],
                  ['Body hash', <span className="font-mono text-xs">{m.bodyHash.slice(0, 16)}…</span>],
                ]}
              />
              {m.attachments.length > 0 && (
                <div className="grid gap-1 text-sm">
                  <div className="font-medium">Attachments</div>
                  {m.attachments.map((a) => (
                    <div key={a.id} className="text-muted-foreground font-mono text-xs">
                      {a.filename} · {a.contentType} · {fmtBytes(a.sizeBytes)}
                    </div>
                  ))}
                </div>
              )}
              {m.metadata && (
                <div className="grid gap-1 text-sm">
                  <div className="font-medium">Metadata</div>
                  <pre className="bg-muted overflow-auto rounded p-2 font-mono text-xs">{JSON.stringify(m.metadata, null, 2)}</pre>
                </div>
              )}
            </TabsContent>
            <TabsContent value="body" className="grid gap-4 pt-3">
              {!m.bodiesVisible ? (
                <p className="text-muted-foreground text-sm">Your role does not allow viewing message bodies.</p>
              ) : m.bodyPurgedAt ? (
                <p className="text-muted-foreground text-sm">Body purged by retention on {fmtDate(m.bodyPurgedAt)}.</p>
              ) : (
                <>
                  {m.hasHtml && <HtmlPreviewFrame id={m.id} />}
                  {m.hasText && (
                    <div className="grid gap-1">
                      <div className="text-sm font-medium">Text</div>
                      <pre className="bg-muted max-h-96 overflow-auto rounded p-3 font-mono text-xs whitespace-pre-wrap">{m.textBody}</pre>
                    </div>
                  )}
                </>
              )}
            </TabsContent>
            <TabsContent value="timeline" className="pt-3">
              <Timeline events={m.events} />
            </TabsContent>
            <TabsContent value="headers" className="pt-3">
              <KV items={Object.entries(m.headers).map(([k, v]) => [<span className="font-mono text-xs">{k}</span>, <span className="font-mono text-xs">{v}</span>])} />
              <a className="text-primary mt-3 inline-flex items-center gap-1 text-xs hover:underline" href={`/admin/messages/${m.id}`} target="_blank" rel="noreferrer">
                Raw JSON <ExternalLink className="size-3" />
              </a>
            </TabsContent>
          </Tabs>
        )}
      </SheetContent>
    </Sheet>
  );
}
