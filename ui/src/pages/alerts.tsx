// Authored by Tomás Neto (TN 2026)
import { MoreHorizontal, Plus, Send } from 'lucide-react';
import { useEffect, useState } from 'react';
import {
  useAlertChannels,
  useAlertEvents,
  useAlertTypes,
  useCreateAlertChannel,
  useDeleteAlertChannel,
  useTestAlertChannel,
  useUpdateAlertChannel,
  type AlertChannelT,
} from '@/api/queries';
import { Signal } from '@/components/common/badges';
import { Callout, CopyButton, EmptyState, Field, PageHeader } from '@/components/common/page';
import { ConfirmDialog } from '@/components/confirm/confirm-dialog';
import { Segmented } from '@/components/keys/segmented';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { useMe } from '@/lib/auth';
import { fmtAgo, fmtTime } from '@/lib/format';
import { ShieldAlert } from 'lucide-react';

type ChannelType = 'webhook' | 'slack' | 'email';
const TARGET_HINT: Record<ChannelType, string> = {
  webhook: 'https://… — receives a signed JSON POST',
  slack: 'Slack incoming webhook URL (https://hooks.slack.com/…)',
  email: 'Comma-separated addresses; needs SYSTEM_MAIL_FROM and a live provider',
};
const SEVERITY_TONE = { critical: 'red', warning: 'amber', info: 'gray' } as const;

function ChannelDialog({ open, onOpenChange, channel }: { open: boolean; onOpenChange: (o: boolean) => void; channel: AlertChannelT | null }) {
  const types = useAlertTypes();
  const create = useCreateAlertChannel();
  const update = useUpdateAlertChannel();
  const [name, setName] = useState('');
  const [type, setType] = useState<ChannelType>('webhook');
  const [target, setTarget] = useState('');
  const [events, setEvents] = useState<string[]>(['*']);
  const [secret, setSecret] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setName(channel?.name ?? '');
    setType((channel?.type as ChannelType) ?? 'webhook');
    setTarget('');
    setEvents(channel?.events ?? ['*']);
    setSecret(null);
  }, [open, channel]);

  const all = events.includes('*');
  const toggle = (t: string) => setEvents((e) => (e.includes(t) ? e.filter((x) => x !== t) : [...e.filter((x) => x !== '*'), t]));
  const valid = name.trim().length >= 2 && (channel ? true : target.trim().length > 3) && events.length > 0;

  const save = async () => {
    if (channel) {
      await update.mutateAsync({ id: channel.id, body: { name, events, ...(target.trim() ? { target } : {}) } });
      onOpenChange(false);
    } else {
      const r = await create.mutateAsync({ name, type, target, events });
      if (r.signingSecret) setSecret(r.signingSecret);
      else onOpenChange(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => (secret ? o || onOpenChange(false) : onOpenChange(o))}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{secret ? 'Webhook signing secret' : channel ? `Edit ${channel.name}` : 'New alert channel'}</DialogTitle>
          <DialogDescription>
            {secret ? 'Shown once. The receiver verifies X-Mail-Gateway-Signature = sha256=HMAC(secret, "<timestamp>.<body>").' : 'Where alerts are delivered, and which ones.'}
          </DialogDescription>
        </DialogHeader>
        {secret ? (
          <div className="grid gap-3">
            <Callout tone="warn" icon={<ShieldAlert />}>
              Store it in the receiving service now; only an encrypted copy is kept.
            </Callout>
            <div className="flex items-center gap-2">
              <code className="bg-muted/60 min-w-0 flex-1 truncate rounded-md border px-3 py-2 font-mono text-xs">{secret}</code>
              <CopyButton value={secret} />
            </div>
          </div>
        ) : (
          <div className="grid gap-4">
            <Field label="Name" htmlFor="ch-name">
              <Input id="ch-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="on-call" />
            </Field>
            {!channel && (
              <Field label="Type">
                <Segmented
                  label="Channel type"
                  value={type}
                  onChange={setType}
                  options={[
                    { value: 'webhook', label: 'Webhook' },
                    { value: 'slack', label: 'Slack' },
                    { value: 'email', label: 'Email' },
                  ]}
                />
              </Field>
            )}
            <Field label={channel ? 'New target (leave empty to keep)' : 'Target'} htmlFor="ch-target" hint={TARGET_HINT[(channel?.type as ChannelType) ?? type]}>
              <Input id="ch-target" value={target} onChange={(e) => setTarget(e.target.value)} placeholder={channel?.targetPreview} className="font-mono text-xs" />
            </Field>
            <fieldset className="grid gap-2">
              <legend className="mb-1 text-sm font-medium">Alerts</legend>
              <label className="flex items-center gap-2 text-sm">
                <Checkbox checked={all} onCheckedChange={(c) => setEvents(c ? ['*'] : [])} /> All alerts
              </label>
              {!all &&
                types.data
                  ?.filter((t) => t.type !== 'test')
                  .map((t) => (
                    <label key={t.type} className="flex items-start gap-2 text-sm">
                      <Checkbox className="mt-0.5" checked={events.includes(t.type)} onCheckedChange={() => toggle(t.type)} />
                      <span>
                        {t.label} <span className="text-muted-foreground font-mono text-xs">{t.type}</span>
                      </span>
                    </label>
                  ))}
            </fieldset>
          </div>
        )}
        <DialogFooter>
          {secret ? (
            <Button onClick={() => onOpenChange(false)}>Done</Button>
          ) : (
            <>
              <Button variant="ghost" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button onClick={() => void save()} disabled={!valid || create.isPending || update.isPending}>
                {channel ? 'Save channel' : 'Create channel'}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function AlertsPage() {
  const { can } = useMe();
  const manage = can('alerts:manage');
  const channels = useAlertChannels();
  const [page, setPage] = useState(1);
  const events = useAlertEvents(page);
  const test = useTestAlertChannel();
  const update = useUpdateAlertChannel();
  const del = useDeleteAlertChannel();
  const [dialog, setDialog] = useState<{ open: boolean; channel: AlertChannelT | null }>({ open: false, channel: null });
  const [deleting, setDeleting] = useState<AlertChannelT | null>(null);
  const pages = events.data ? Math.max(1, Math.ceil(events.data.total / events.data.pageSize)) : 1;

  return (
    <>
      <PageHeader
        title="Alerts"
        description="Who hears about breaker trips, pauses, rejection spikes, quotas, waiting approvals and expiring keys"
        actions={
          manage && (
            <Button onClick={() => setDialog({ open: true, channel: null })}>
              <Plus /> New channel
            </Button>
          )
        }
      />
      <div className="grid w-full max-w-[1440px] gap-6 px-4 sm:px-8 py-6 xl:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
        <Card className="content-start gap-4">
          <CardHeader>
            <CardTitle>Channels</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-2">
            {channels.isLoading && <Skeleton className="h-20 w-full" />}
            {channels.data?.items.length === 0 && <EmptyState title="No channels yet" description="Alerts are recorded below but nobody is notified." className="py-8" />}
            {channels.data?.items.map((c) => (
              <div key={c.id} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 rounded-lg border px-4 py-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <Signal tone={!c.enabled ? 'gray' : c.lastError ? 'red' : 'green'} hollow={!c.enabled} className="font-medium">
                      {c.name}
                    </Signal>
                    <span className="text-muted-foreground font-mono text-xs">{c.type}</span>
                  </div>
                  <div className="text-secondary-foreground truncate pl-4 font-mono text-xs">{c.targetPreview}</div>
                  <div className="text-muted-foreground truncate pl-4 text-xs">
                    {c.events.includes('*') ? 'All alerts' : c.events.join(', ')}
                    {c.lastDeliveredAt ? ` · last delivered ${fmtAgo(c.lastDeliveredAt)}` : ''}
                  </div>
                  {c.lastError && <div className="text-destructive truncate pl-4 text-xs" title={c.lastError}>{c.lastError}</div>}
                </div>
                {manage && (
                  <div className="flex items-center gap-1">
                    <Button size="sm" variant="outline" onClick={() => test.mutate(c.id)} disabled={!c.enabled}>
                      <Send /> Test
                    </Button>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button size="icon-sm" variant="ghost" aria-label={`Actions for ${c.name}`}>
                          <MoreHorizontal />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem onClick={() => setDialog({ open: true, channel: c })}>Edit</DropdownMenuItem>
                        <DropdownMenuItem onClick={() => update.mutate({ id: c.id, body: { enabled: !c.enabled } })}>{c.enabled ? 'Disable' : 'Enable'}</DropdownMenuItem>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem variant="destructive" onClick={() => setDeleting(c)}>
                          Delete
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                )}
              </div>
            ))}
          </CardContent>
        </Card>

        <Card className="content-start gap-4">
          <CardHeader className="flex flex-row items-center justify-between">
            <CardTitle>Recent alerts</CardTitle>
            {events.data && events.data.total > events.data.pageSize && (
              <div className="text-muted-foreground flex items-center gap-2 text-xs">
                <Button size="sm" variant="ghost" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
                  Newer
                </Button>
                <span className="tabular">
                  {page} / {pages}
                </span>
                <Button size="sm" variant="ghost" disabled={page >= pages} onClick={() => setPage((p) => p + 1)}>
                  Older
                </Button>
              </div>
            )}
          </CardHeader>
          <CardContent>
            {events.isLoading && <Skeleton className="h-40 w-full" />}
            {events.data?.items.length === 0 && <EmptyState title="Nothing has happened yet" className="py-8" />}
            <ol className="grid">
              {events.data?.items.map((e) => (
                <li key={e.id} className="grid gap-0.5 border-b py-3 last:border-0">
                  <div className="flex items-baseline justify-between gap-4">
                    <Signal tone={SEVERITY_TONE[e.severity as keyof typeof SEVERITY_TONE] ?? 'gray'} className="min-w-0 text-sm">
                      <span className="truncate">{e.title}</span>
                    </Signal>
                    <span className="text-muted-foreground tabular shrink-0 font-mono text-xs">{fmtTime(e.at)}</span>
                  </div>
                  <div className="text-muted-foreground pl-4 font-mono text-xs">
                    {e.type}
                    {e.deliveredTo.length ? ` · sent to ${e.deliveredTo.join(', ')}` : ''}
                    {e.failedTo.length ? <span className="text-destructive"> · failed: {e.failedTo.join(', ')}</span> : null}
                  </div>
                </li>
              ))}
            </ol>
          </CardContent>
        </Card>
      </div>
      <ChannelDialog open={dialog.open} channel={dialog.channel} onOpenChange={(o) => setDialog((d) => ({ ...d, open: o }))} />
      <ConfirmDialog
        open={!!deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
        title={`Delete channel "${deleting?.name}"?`}
        description="Alerts stop being delivered there. The history is kept."
        confirmLabel="Delete channel"
        destructive
        onConfirm={async () => {
          if (deleting) await del.mutateAsync(deleting.id);
          setDeleting(null);
        }}
      />
    </>
  );
}
