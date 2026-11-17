import { useNavigate, useSearch } from '@tanstack/react-router';
import { Check, X } from 'lucide-react';
import { useState } from 'react';
import { useApprove, useKeys, useMessages, useReject, type Message, type MessageListParams } from '@/api/queries';
import { ModeBadge, OutcomeBadge, Pill, STATUS_LABEL, StatusBadge } from '@/components/common/badges';
import { ExportMenu } from '@/components/common/export-menu';
import { PageHeader } from '@/components/common/page';
import { ConfirmDialog } from '@/components/confirm/confirm-dialog';
import { DataTable, type Column } from '@/components/data-table/data-table';
import { MessageDrawer } from '@/components/messages/message-drawer';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useMe } from '@/lib/auth';
import { fmtAgo, fmtShort } from '@/lib/format';

export type MessagesSearch = MessageListParams & { id?: string };

function recipients(m: Message) {
  const all = [...m.to, ...m.cc, ...m.bcc];
  return all.length > 1 ? `${all[0]} +${all.length - 1}` : (all[0] ?? '—');
}

const baseCols: Column<Message>[] = [
  { id: 'status', header: 'Status', sortable: true, cell: (m) => <StatusBadge status={m.status} /> },
  {
    id: 'subject',
    header: 'Subject',
    sortable: true,
    className: 'max-w-[360px]',
    cell: (m) => (
      <div className="min-w-0">
        <div className="truncate font-medium">{m.subject || <span className="text-muted-foreground">(no subject)</span>}</div>
        {m.rejectCode && <div className="text-destructive font-mono text-[11px]">{m.rejectCode}</div>}
      </div>
    ),
  },
  { id: 'to', header: 'Recipients', cell: (m) => <span className="text-muted-foreground text-xs">{recipients(m)}</span> },
  {
    id: 'key',
    header: 'Key',
    cell: (m) => (
      <span className="flex items-center gap-1.5 text-xs">
        {m.apiKey.name} <ModeBadge mode={m.deliveryMode} />
        {m.source === 'admin_test' && <Pill color="blue">test</Pill>}
      </span>
    ),
  },
  { id: 'outcome', header: '', cell: (m) => <OutcomeBadge outcome={m.deliveryOutcome} /> },
  { id: 'createdAt', header: 'Created', sortable: true, cell: (m) => <span className="text-muted-foreground text-xs whitespace-nowrap" title={m.createdAt}>{fmtShort(m.createdAt)}</span> },
];

export function MessagesPage() {
  const search = useSearch({ strict: false }) as MessagesSearch;
  const navigate = useNavigate();
  const { id, ...filters } = search;
  const q: MessageListParams = { page: 1, pageSize: 50, sort: 'createdAt', order: 'desc', ...filters };
  const { data, isLoading } = useMessages(q, { refetchInterval: 10_000 });
  const keys = useKeys({ pageSize: 200 });
  const set = (patch: Partial<MessagesSearch>) => navigate({ to: '/messages', search: { ...search, page: 1, ...patch } as never, replace: true });
  const statuses = (filters.status ?? '').split(',').filter(Boolean);

  return (
    <>
      <PageHeader
        title="Messages"
        description="Every request after authentication: accepted or rejected."
        actions={
          <ExportMenu
            path="/admin/messages/export.csv"
            params={{ status: filters.status, keyId: filters.keyId, recipient: filters.recipient, subject: filters.subject, from: filters.from, to: filters.to }}
          />
        }
      />
      <div className="flex flex-wrap items-center gap-2 border-b px-6 py-2">
        <Input placeholder="Subject contains…" className="h-8 w-52" defaultValue={filters.subject} onChange={(e) => set({ subject: e.target.value || undefined })} />
        <Input placeholder="Recipient (exact)" className="h-8 w-52" defaultValue={filters.recipient} onBlur={(e) => set({ recipient: e.target.value.trim() || undefined })} />
        <select
          aria-label="Key"
          className="border-input h-8 rounded-md border bg-transparent px-2 text-sm"
          value={filters.keyId ?? ''}
          onChange={(e) => set({ keyId: e.target.value || undefined })}
        >
          <option value="">All keys</option>
          {keys.data?.items.map((k) => (
            <option key={k.id} value={k.id}>
              {k.name}
            </option>
          ))}
        </select>
        <label className="text-muted-foreground flex items-center gap-1 text-xs">
          From
          <input type="date" aria-label="From date" className="border-input h-8 rounded-md border bg-transparent px-2 text-sm" value={filters.from?.slice(0, 10) ?? ''} onChange={(e) => set({ from: e.target.value ? new Date(e.target.value).toISOString() : undefined })} />
        </label>
        <label className="text-muted-foreground flex items-center gap-1 text-xs">
          To
          <input
            type="date"
            aria-label="To date"
            className="border-input h-8 rounded-md border bg-transparent px-2 text-sm"
            value={filters.to?.slice(0, 10) ?? ''}
            onChange={(e) => set({ to: e.target.value ? new Date(`${e.target.value}T23:59:59`).toISOString() : undefined })}
          />
        </label>
        <div className="flex flex-wrap gap-1">
          {Object.keys(STATUS_LABEL).map((s) => {
            const on = statuses.includes(s);
            return (
              <Button
                key={s}
                size="sm"
                variant={on ? 'secondary' : 'ghost'}
                className="h-7 text-xs"
                aria-pressed={on}
                onClick={() => {
                  const next = on ? statuses.filter((x) => x !== s) : [...statuses, s];
                  set({ status: next.join(',') || undefined });
                }}
              >
                {STATUS_LABEL[s]}
              </Button>
            );
          })}
        </div>
        {Object.keys(filters).some((k) => !['page', 'pageSize', 'sort', 'order'].includes(k)) && (
          <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => navigate({ to: '/messages', search: {} as never })}>
            Clear
          </Button>
        )}
      </div>
      <DataTable
        columns={baseCols}
        rows={data?.items}
        rowKey={(m) => m.id}
        loading={isLoading}
        total={data?.total}
        page={q.page}
        pageSize={q.pageSize}
        onPage={(page) => navigate({ to: '/messages', search: { ...search, page } as never })}
        sort={q.sort}
        order={q.order}
        onSort={(sort, order) => set({ sort: sort as MessageListParams['sort'], order })}
        onRowClick={(m) => navigate({ to: '/messages', search: { ...search, id: m.id } as never })}
        activeKey={id}
        empty={{ title: 'No messages match', description: 'Adjust the filters or send a test email from a key page.' }}
      />
      <MessageDrawer id={id} onClose={() => navigate({ to: '/messages', search: { ...search, id: undefined } as never })} />
    </>
  );
}

export function ApprovalsPage() {
  const navigate = useNavigate();
  const search = useSearch({ strict: false }) as { id?: string; page?: number };
  const { can } = useMe();
  const canDecide = can('approvals:decide');
  const q: MessageListParams = { status: 'pending_approval', page: search.page ?? 1, pageSize: 50, sort: 'createdAt', order: 'asc' };
  const { data, isLoading } = useMessages(q, { refetchInterval: 10_000 });
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [rejecting, setRejecting] = useState<string[] | null>(null);
  const approve = useApprove();
  const reject = useReject();

  const cols: Column<Message>[] = [
    ...baseCols.filter((c) => c.id !== 'status' && c.id !== 'outcome'),
    { id: 'age', header: 'Waiting', cell: (m) => <span className="text-muted-foreground text-xs">{fmtAgo(m.createdAt)}</span> },
    ...(canDecide
      ? [
          {
            id: 'actions',
            header: '',
            className: 'text-right pr-6',
            cell: (m: Message) => (
              <div className="flex justify-end gap-1" onClick={(e) => e.stopPropagation()}>
                <Button size="sm" variant="outline" className="h-7" onClick={() => approve.mutate([m.id])}>
                  <Check className="size-3.5" /> Approve
                </Button>
                <Button size="sm" variant="ghost" className="h-7" onClick={() => setRejecting([m.id])}>
                  <X className="size-3.5" /> Reject
                </Button>
              </div>
            ),
          },
        ]
      : []),
  ];

  return (
    <>
      <PageHeader
        title="Approvals"
        description="Messages from keys in approval mode. Approved messages are delivered live."
        actions={
          canDecide &&
          selected.size > 0 && (
            <>
              <span className="text-muted-foreground text-xs">{selected.size} selected</span>
              <Button
                size="sm"
                onClick={async () => {
                  await approve.mutateAsync([...selected]);
                  setSelected(new Set());
                }}
              >
                <Check className="size-4" /> Approve selected
              </Button>
              <Button size="sm" variant="outline" onClick={() => setRejecting([...selected])}>
                <X className="size-4" /> Reject selected
              </Button>
            </>
          )
        }
      />
      <DataTable
        columns={cols}
        rows={data?.items}
        rowKey={(m) => m.id}
        loading={isLoading}
        total={data?.total}
        page={q.page}
        pageSize={q.pageSize}
        onPage={(page) => navigate({ to: '/approvals', search: { page } as never })}
        selected={canDecide ? selected : undefined}
        onSelectedChange={canDecide ? setSelected : undefined}
        onRowClick={(m) => navigate({ to: '/approvals', search: { ...search, id: m.id } as never })}
        activeKey={search.id}
        empty={{ title: 'Inbox zero', description: 'Nothing is waiting for approval.' }}
      />
      <MessageDrawer id={search.id} onClose={() => navigate({ to: '/approvals', search: { ...search, id: undefined } as never })} />
      <ConfirmDialog
        open={!!rejecting}
        onOpenChange={(o) => !o && setRejecting(null)}
        title={`Reject ${rejecting?.length ?? 0} message${rejecting?.length === 1 ? '' : 's'}?`}
        description="Rejected messages are never delivered. The client sees status rejected with your reason."
        confirmLabel="Reject"
        destructive
        reasonLabel="Reason (optional)"
        onConfirm={async (reason) => {
          await reject.mutateAsync({ ids: rejecting ?? [], reason: reason || undefined });
          setSelected(new Set());
        }}
      />
    </>
  );
}
