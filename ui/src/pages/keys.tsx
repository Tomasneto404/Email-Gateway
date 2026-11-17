// Authored by Tomás Neto (TN 2026)
import { Link, useNavigate, useParams, useSearch } from '@tanstack/react-router';
import { ArrowLeft, Download, MoreHorizontal, Power, RotateCw, Trash2 } from 'lucide-react';
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
import { ModeBadge, Pill, STATUS_LABEL, Signal, StatusDot } from '@/components/common/badges';
import { exportUrl } from '@/components/common/export-menu';
import { EmptyState, PageHeader } from '@/components/common/page';
import { ConfirmDialog } from '@/components/confirm/confirm-dialog';
import { VolumeChart } from '@/components/dashboard/charts';
import { DataTable, type Column } from '@/components/data-table/data-table';
import { CreateKeyWizard } from '@/components/keys/create-key-wizard';
import { PolicyEditor } from '@/components/keys/policy-editor';
import { Segmented } from '@/components/keys/segmented';
import { SecretReveal } from '@/components/keys/secret-reveal';
import { TestSendDialog } from '@/components/keys/test-send-dialog';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
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
      <div className="bg-muted h-1 w-16 overflow-hidden rounded-full">
        <div className={cn('h-full rounded-full', pct >= 90 ? 'bg-destructive' : pct >= 70 ? 'bg-warning' : 'bg-foreground/35')} style={{ width: `${Math.max(pct, used > 0 ? 3 : 0)}%` }} />
      </div>
      <span className="tabular text-secondary-foreground font-mono text-xs">
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
          <div className="text-muted-foreground font-mono text-xs">{k.keyPrefix}</div>
        </div>
      ),
    },
    { id: 'mode', header: 'Mode', cell: (k) => <ModeBadge mode={k.mode} /> },
    { id: 'enabled', header: 'Status', cell: (k) => (k.enabled ? <Signal tone="green" className="text-secondary-foreground">enabled</Signal> : <Signal tone="red" className="text-destructive">disabled</Signal>) },
    { id: 'from', header: 'From', cell: (k) => <span className="text-secondary-foreground">{k.fromAddress}</span> },
    { id: 'today', header: 'Today', cell: (k) => <UsageBar used={k.usage.day} limit={k.quotaPerDay} /> },
    { id: 'hour', header: 'This hour', cell: (k) => <UsageBar used={k.usage.hour} limit={k.quotaPerHour} /> },
    { id: 'lastUsedAt', header: 'Last used', sortable: true, cell: (k) => <span className="text-secondary-foreground" title={k.lastUsedAt ?? undefined}>{fmtAgo(k.lastUsedAt)}</span> },
  ];

  return (
    <>
      <PageHeader title="API keys" description="Each key carries its own sending policy" actions={can('keys:create') && <CreateKeyWizard />} />
      <div className="flex flex-wrap items-center gap-2 border-b px-8 py-3">
        <Input placeholder="Filter by name" className="h-8 w-56" defaultValue={search.q} onChange={(e) => set({ q: e.target.value || undefined })} />
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
  const [secretAck, setSecretAck] = useState(false);
  const [from] = useState(() => new Date(Date.now() - 24 * 3600_000).toISOString());
  const stats = useStats({ keyId, from, bucket: 'hour' });
  const recent = useMessages({ keyId, pageSize: 10 });

  if (error) return <EmptyState title="Key not found" description="It may have been deleted" />;
  if (isLoading || !k)
    return (
      <div className="grid gap-3 px-8 py-6">
        <Skeleton className="h-6 w-60" />
        <Skeleton className="h-40 w-full" />
      </div>
    );

  return (
    <>
      <PageHeader
        title={
          <span className="flex items-center gap-3">
            <Link to="/keys" className="text-muted-foreground hover:text-foreground -ml-1 rounded-sm p-1" aria-label="Back to keys">
              <ArrowLeft className="size-4" />
            </Link>
            {k.name}
            <span className="text-sm font-normal">
              <ModeBadge mode={k.mode} />
            </span>
            {!k.enabled && <Pill color="red">disabled</Pill>}
          </span>
        }
        description={
          <>
            <span className="font-mono text-xs">{k.keyPrefix}</span> · created {fmtShort(k.createdAt)} · last used {fmtAgo(k.lastUsedAt)}
            {k.prefixStale && <span className="text-warning-foreground ml-2">Prefix no longer matches the mode, rotate to get a {k.mode === 'sandbox' ? 'mk_sbx_' : 'mk_live_'} key</span>}
          </>
        }
        actions={
          <>
            {can('keys:test_send') && <TestSendDialog policy={k} disabled={!k.enabled} />}
            {canAny('messages:read', 'audit:read') && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button size="sm" variant="outline">
                    <Download className="size-4" /> Export
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-64">
                  {can('messages:read') && (
                    <>
                      <DropdownMenuItem asChild>
                        <a href={exportUrl('/admin/messages/export.csv', { keyId })} download data-testid="export-key-messages">
                          Messages sent by this key (CSV)
                        </a>
                      </DropdownMenuItem>
                      <DropdownMenuItem asChild>
                        <a href={exportUrl('/admin/messages/export.csv', { keyId }, 'semicolon')} download>
                          Messages — Excel (semicolon)
                        </a>
                      </DropdownMenuItem>
                    </>
                  )}
                  {can('audit:read') && (
                    <>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem asChild>
                        <a href={exportUrl('/admin/audit/export.csv', { keyId })} download data-testid="export-key-activity">
                          Activity on this key (CSV)
                        </a>
                      </DropdownMenuItem>
                      <DropdownMenuItem asChild>
                        <a href={exportUrl('/admin/audit/export.csv', { keyId }, 'semicolon')} download>
                          Activity — Excel (semicolon)
                        </a>
                      </DropdownMenuItem>
                      <DropdownMenuItem asChild>
                        <Link to="/activity" search={{ keyId }}>
                          View activity on this key
                        </Link>
                      </DropdownMenuItem>
                    </>
                  )}
                </DropdownMenuContent>
              </DropdownMenu>
            )}
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
      <div className="grid w-full max-w-[1440px] gap-6 px-8 py-6 xl:grid-cols-[minmax(0,1fr)_400px]">
        <Card>
          <CardHeader>
            <CardTitle>Policy</CardTitle>
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
              <CardTitle>Last 24 hours</CardTitle>
            </CardHeader>
            <CardContent>
              <dl className="mb-4 grid grid-cols-2 gap-4">
                <div>
                  <dt className="text-secondary-foreground text-xs">This hour</dt>
                  <dd className="tabular mt-1 text-xl leading-7 font-medium">
                    {fmtNum(k.usage.hour)}
                    <span className="text-muted-foreground text-sm font-normal"> / {fmtNum(k.quotaPerHour)}</span>
                  </dd>
                </div>
                <div>
                  <dt className="text-secondary-foreground text-xs">Today</dt>
                  <dd className="tabular mt-1 text-xl leading-7 font-medium">
                    {fmtNum(k.usage.day)}
                    <span className="text-muted-foreground text-sm font-normal"> / {fmtNum(k.quotaPerDay)}</span>
                  </dd>
                </div>
              </dl>
              <VolumeChart series={stats.data?.series} bucket="hour" height={180} />
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="flex flex-row items-center justify-between">
              <CardTitle>Recent messages</CardTitle>
              <Link to="/messages" search={{ keyId }} className="text-brand text-sm hover:underline">
                View all
              </Link>
            </CardHeader>
            <CardContent className="grid gap-0.5">
              {recent.data?.items.length === 0 && <p className="text-muted-foreground text-sm">No messages yet</p>}
              {recent.data?.items.map((m) => (
                <Link
                  key={m.id}
                  to="/messages"
                  search={{ keyId, id: m.id }}
                  title={STATUS_LABEL[m.status]}
                  className="hover:bg-accent -mx-2 grid h-9 grid-cols-[8px_minmax(0,1fr)_auto] items-center gap-3 rounded-md px-2 text-sm transition-colors"
                >
                  <StatusDot status={m.status} />
                  <span className={cn('truncate', m.status === 'failed' && 'text-destructive')}>{m.subject || '(no subject)'}</span>
                  <span className="text-muted-foreground tabular font-mono text-xs">{fmtShort(m.createdAt)}</span>
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
          setSecretAck(false);
          setNewSecret(r.secret);
        }}
      />
      <ConfirmDialog
        open={dialog === 'disable'}
        onOpenChange={(o) => !o && setDialog(null)}
        title={`Disable "${k.name}"?`}
        description="Every send with this key will be rejected with KEY_DISABLED until it is re-enabled"
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
      <Dialog open={!!newSecret} onOpenChange={(o) => !o && secretAck && setNewSecret(null)}>
        <DialogContent className="sm:max-w-xl" onInteractOutside={(e) => e.preventDefault()} onEscapeKeyDown={(e) => !secretAck && e.preventDefault()} showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>New secret for {k.name}</DialogTitle>
            <DialogDescription>The key was rotated. Update every client that used the old secret.</DialogDescription>
          </DialogHeader>
          {newSecret && <SecretReveal secret={newSecret} name={k.name} mode={k.mode} rotated onAcknowledgedChange={setSecretAck} />}
          <DialogFooter>
            <Button disabled={!secretAck} onClick={() => setNewSecret(null)}>
              Done
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
