import { Link, useNavigate, useParams, useSearch } from '@tanstack/react-router';
import { ArrowLeft, MoreHorizontal, Power, RotateCw, Trash2 } from 'lucide-react';
import { useState } from 'react';
import {
  useDeleteKey,
  useKey,
  useKeys,
  useMessages,
  useRotateKey,
  useSetKeyEnabled,
  useSettings,
  useStats,
  useUpdateKey,
  type Key,
  type KeyListParams,
} from '@/api/queries';
import { ModeBadge, Pill, StatusBadge } from '@/components/common/badges';
import { EmptyState, PageHeader } from '@/components/common/page';
import { ConfirmDialog } from '@/components/confirm/confirm-dialog';
import { Legend, VolumeChart } from '@/components/dashboard/charts';
import { DataTable, type Column } from '@/components/data-table/data-table';
import { CreateKeyWizard } from '@/components/keys/create-key-wizard';
import { PolicyEditor } from '@/components/keys/policy-editor';
import { Segmented } from '@/components/keys/segmented';
import { SecretReveal } from '@/components/keys/secret-reveal';
import { TestSendDialog } from '@/components/keys/test-send-dialog';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { useMe } from '@/lib/auth';
import { fmtAgo, fmtNum, fmtShort } from '@/lib/format';
import { cn } from '@/lib/utils';

function UsageBar({ used, limit }: { used: number; limit: number }) {
  const pct = limit > 0 ? Math.min(100, (used / limit) * 100) : 100;
  return (
    <div className="flex items-center gap-2">
      <div className="bg-muted h-1.5 w-20 overflow-hidden rounded-full">
        <div className={cn('h-full rounded-full', pct >= 90 ? 'bg-red-500' : pct >= 70 ? 'bg-amber-500' : 'bg-primary')} style={{ width: `${pct}%` }} />
      </div>
      <span className="tabular text-muted-foreground text-xs">
        {fmtNum(used)}/{fmtNum(limit)}
      </span>
    </div>
  );
}

export function KeysPage() {
  const search = useSearch({ strict: false }) as KeyListParams;
  const navigate = useNavigate();
  const { can } = useMe();
  const q: KeyListParams = { page: 1, pageSize: 50, sort: 'name', order: 'asc', ...search };
  const { data, isLoading } = useKeys(q);
  const set = (patch: Partial<KeyListParams>) => navigate({ to: '/keys', search: { ...search, page: 1, ...patch } as never });

  const cols: Column<Key>[] = [
    {
      id: 'name',
      header: 'Name',
      sortable: true,
      cell: (k) => (
        <div className="min-w-0">
          <div className="font-medium">{k.name}</div>
          <div className="text-muted-foreground font-mono text-[11px]">{k.keyPrefix}</div>
        </div>
      ),
    },
    { id: 'mode', header: 'Mode', cell: (k) => <ModeBadge mode={k.mode} /> },
    { id: 'enabled', header: 'Status', cell: (k) => (k.enabled ? <Pill color="green" dot>enabled</Pill> : <Pill color="red" dot>disabled</Pill>) },
    { id: 'from', header: 'From', cell: (k) => <span className="text-muted-foreground text-xs">{k.fromAddress}</span> },
    { id: 'today', header: 'Today', cell: (k) => <UsageBar used={k.usage.day} limit={k.quotaPerDay} /> },
    { id: 'hour', header: 'This hour', cell: (k) => <UsageBar used={k.usage.hour} limit={k.quotaPerHour} /> },
    { id: 'lastUsedAt', header: 'Last used', sortable: true, cell: (k) => <span className="text-muted-foreground text-xs">{fmtAgo(k.lastUsedAt)}</span> },
  ];

  return (
    <>
      <PageHeader title="API keys" description="Each key carries its own sending policy." actions={can('keys:create') && <CreateKeyWizard />} />
      <div className="flex flex-wrap items-center gap-2 border-b px-6 py-2">
        <Input placeholder="Filter by name…" className="h-8 w-56" defaultValue={search.q} onChange={(e) => set({ q: e.target.value || undefined })} />
        <Segmented
          label="Mode filter"
          size="sm"
          value={search.mode ?? 'all'}
          onChange={(m) => set({ mode: m === 'all' ? undefined : m })}
          options={[
            { value: 'all', label: 'All' },
            { value: 'sandbox', label: 'Sandbox' },
            { value: 'approval', label: 'Approval' },
            { value: 'live', label: 'Live' },
          ]}
        />
      </div>
      <DataTable
        columns={cols}
        rows={data?.items}
        rowKey={(k) => k.id}
        loading={isLoading}
        total={data?.total}
        page={q.page}
        pageSize={q.pageSize}
        onPage={(page) => navigate({ to: '/keys', search: { ...search, page } as never })}
        sort={q.sort}
        order={q.order}
        onSort={(sort, order) => set({ sort: sort as KeyListParams['sort'], order })}
        onRowClick={(k) => navigate({ to: '/keys/$keyId', params: { keyId: k.id } })}
        empty={{ title: 'No API keys yet', description: can('keys:create') ? 'Create the first key with "New key". It starts in sandbox mode.' : undefined }}
      />
    </>
  );
}

export function KeyDetailPage() {
  const { keyId } = useParams({ strict: false }) as { keyId: string };
  const navigate = useNavigate();
  const { can, canAny } = useMe();
  const { data: k, isLoading, error } = useKey(keyId);
  const settings = useSettings();
  const update = useUpdateKey(keyId);
  const rotate = useRotateKey(keyId);
  const setEnabled = useSetKeyEnabled(keyId);
  const del = useDeleteKey(keyId);
  const [dialog, setDialog] = useState<'rotate' | 'disable' | 'delete' | null>(null);
  const [newSecret, setNewSecret] = useState<string | null>(null);
  const [from] = useState(() => new Date(Date.now() - 24 * 3600_000).toISOString());
  const stats = useStats({ keyId, from, bucket: 'hour' });
  const recent = useMessages({ keyId, pageSize: 10 });

  if (error) return <EmptyState title="Key not found" description="It may have been deleted." />;
  if (isLoading || !k)
    return (
      <div className="grid gap-3 p-6">
        <Skeleton className="h-6 w-60" />
        <Skeleton className="h-40 w-full" />
      </div>
    );

  return (
    <>
      <PageHeader
        title={
          <span className="flex items-center gap-2">
            <Link to="/keys" className="text-muted-foreground hover:text-foreground" aria-label="Back to keys">
              <ArrowLeft className="size-4" />
            </Link>
            {k.name}
            <ModeBadge mode={k.mode} />
            {!k.enabled && <Pill color="red">disabled</Pill>}
          </span>
        }
        description={
          <>
            <span className="font-mono text-xs">{k.keyPrefix}</span> · created {fmtShort(k.createdAt)} · last used {fmtAgo(k.lastUsedAt)}
            {k.prefixStale && <span className="ml-2 text-amber-600 dark:text-amber-400">Prefix no longer matches the mode — rotate to get a {k.mode === 'sandbox' ? 'mk_sbx_' : 'mk_live_'} key.</span>}
          </>
        }
        actions={
          <>
            {can('keys:test_send') && <TestSendDialog policy={k} disabled={!k.enabled} />}
            {canAny('keys:rotate', 'keys:disable', 'keys:delete') && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button size="icon" variant="outline" className="size-8" aria-label="Key actions">
                    <MoreHorizontal className="size-4" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  {can('keys:rotate') && (
                    <DropdownMenuItem onClick={() => setDialog('rotate')}>
                      <RotateCw className="size-4" /> Rotate secret…
                    </DropdownMenuItem>
                  )}
                  {can('keys:disable') &&
                    (k.enabled ? (
                      <DropdownMenuItem onClick={() => setDialog('disable')}>
                        <Power className="size-4" /> Disable (kill switch)…
                      </DropdownMenuItem>
                    ) : (
                      <DropdownMenuItem onClick={() => setEnabled.mutate(true)}>
                        <Power className="size-4" /> Enable
                      </DropdownMenuItem>
                    ))}
                  {can('keys:delete') && (
                    <>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem variant="destructive" onClick={() => setDialog('delete')}>
                        <Trash2 className="size-4" /> Delete…
                      </DropdownMenuItem>
                    </>
                  )}
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </>
        }
      />
      <div className="grid w-full max-w-7xl gap-6 p-6 xl:grid-cols-[minmax(0,1fr)_380px]">
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Policy</CardTitle>
          </CardHeader>
          <CardContent>
            <PolicyEditor
              policy={k}
              readOnly={!can('keys:update') && !can('keys:promote')}
              canUpdate={can('keys:update')}
              canPromote={can('keys:promote')}
              providers={settings.data ? { smtp: settings.data.smtp.enabled, resend: settings.data.resend.enabled } : undefined}
              onSave={(patch) => update.mutateAsync(patch)}
            />
          </CardContent>
        </Card>
        <div className="grid content-start gap-6">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between">
              <CardTitle className="text-sm">Last 24h</CardTitle>
              <Legend />
            </CardHeader>
            <CardContent>
              <div className="text-muted-foreground mb-2 flex gap-4 text-xs">
                <span>
                  Hour <b className="text-foreground tabular">{k.usage.hour}</b>/{k.quotaPerHour}
                </span>
                <span>
                  Day <b className="text-foreground tabular">{k.usage.day}</b>/{k.quotaPerDay}
                </span>
              </div>
              <VolumeChart series={stats.data?.series} bucket="hour" height={160} />
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="flex flex-row items-center justify-between">
              <CardTitle className="text-sm">Recent messages</CardTitle>
              <Link to="/messages" search={{ keyId }} className="text-primary text-xs hover:underline">
                View all
              </Link>
            </CardHeader>
            <CardContent className="grid gap-1">
              {recent.data?.items.length === 0 && <p className="text-muted-foreground text-sm">No messages yet.</p>}
              {recent.data?.items.map((m) => (
                <Link key={m.id} to="/messages" search={{ keyId, id: m.id }} className="hover:bg-accent -mx-2 flex items-center gap-2 rounded px-2 py-1.5 text-sm">
                  <StatusBadge status={m.status} />
                  <span className="min-w-0 flex-1 truncate">{m.subject || '(no subject)'}</span>
                  <span className="text-muted-foreground shrink-0 text-xs">{fmtAgo(m.createdAt)}</span>
                </Link>
              ))}
            </CardContent>
          </Card>
        </div>
      </div>

      <ConfirmDialog
        open={dialog === 'rotate'}
        onOpenChange={(o) => !o && setDialog(null)}
        title={`Rotate "${k.name}"?`}
        description="The current secret stops working immediately. Every client using it must be updated."
        confirmLabel="Rotate secret"
        destructive
        typeToConfirm={k.name}
        onConfirm={async () => {
          const r = await rotate.mutateAsync();
          setNewSecret(r.secret);
        }}
      />
      <ConfirmDialog
        open={dialog === 'disable'}
        onOpenChange={(o) => !o && setDialog(null)}
        title={`Disable "${k.name}"?`}
        description="Every send with this key will be rejected with KEY_DISABLED until it is re-enabled."
        confirmLabel="Disable key"
        destructive
        typeToConfirm={k.name}
        onConfirm={async () => {
          await setEnabled.mutateAsync(false);
        }}
      />
      <ConfirmDialog
        open={dialog === 'delete'}
        onOpenChange={(o) => !o && setDialog(null)}
        title={`Delete "${k.name}"?`}
        description="The key stops working immediately. Its messages stay in the audit log."
        confirmLabel="Delete key"
        destructive
        typeToConfirm={k.name}
        onConfirm={async () => {
          await del.mutateAsync();
          navigate({ to: '/keys' });
        }}
      />
      <Dialog open={!!newSecret} onOpenChange={(o) => !o && setNewSecret(null)}>
        <DialogContent onInteractOutside={(e) => e.preventDefault()}>
          <DialogHeader>
            <DialogTitle>New secret for {k.name}</DialogTitle>
          </DialogHeader>
          {newSecret && <SecretReveal secret={newSecret} name={k.name} />}
          <DialogFooter>
            <Button onClick={() => setNewSecret(null)}>I&apos;ve stored the key</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
