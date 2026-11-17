// Authored by Tomás Neto (TN 2026)
import { useNavigate, useSearch } from '@tanstack/react-router';
import { useAudit, useKeyLookup, useUsersLookup, type AuditParams } from '@/api/queries';
import { ExportMenu } from '@/components/common/export-menu';
import { useMe } from '@/lib/auth';
import { X } from 'lucide-react';
import type { Schemas } from '@/api/client';
import { Pill, Signal } from '@/components/common/badges';
import { PageHeader } from '@/components/common/page';
import { DataTable, type Column } from '@/components/data-table/data-table';
import { Input } from '@/components/ui/input';
import { fmtTime } from '@/lib/format';

type Entry = Schemas['AuditEntryDto'];

const cols: Column<Entry>[] = [
  { id: 'at', header: 'Time', cell: (a) => <span className="text-secondary-foreground tabular font-mono text-xs whitespace-nowrap" title={a.at}>{fmtTime(a.at)}</span> },
  {
    id: 'actor',
    header: 'Actor',
    cell: (a) => (
      <span className="flex items-center gap-2">
        {a.actorType === 'user' ? a.actorLabel : <span className="text-secondary-foreground font-mono text-xs">{a.actorLabel}</span>}
        {a.actorType !== 'user' && a.actorType !== a.actorLabel && <Pill>{a.actorType}</Pill>}
      </span>
    ),
  },
  { id: 'action', header: 'Action', cell: (a) => <span className="font-mono text-xs">{a.action}</span> },
  { id: 'outcome', header: 'Outcome', cell: (a) => (a.outcome === 'success' ? <Signal tone="green" className="text-secondary-foreground">{a.outcome}</Signal> : <Signal tone="red" className="text-destructive">{a.outcome}</Signal>) },
  {
    id: 'details',
    header: 'Details',
    className: 'max-w-md',
    cell: (a) => (
      <span className="text-muted-foreground block truncate font-mono text-xs" title={a.details ? JSON.stringify(a.details) : ''}>
        {a.targetType ? `${a.targetType}:${a.targetId?.slice(-8) ?? ''} ` : ''}
        {a.details ? JSON.stringify(a.details) : ''}
      </span>
    ),
  },
  { id: 'ip', header: 'IP', cell: (a) => <span className="text-muted-foreground font-mono text-xs">{a.ip ?? '—'}</span> },
];

function ScopeChip({ label, value, onClear }: { label: string; value: string; onClear: () => void }) {
  return (
    <span data-testid="scope-chip" className="bg-card inline-flex h-8 items-center gap-2 rounded-md border px-2.5 text-sm">
      {label}: {value}
      <button type="button" aria-label={`Clear ${label} filter`} onClick={onClear} className="hover:text-foreground">
        <X className="size-3.5" />
      </button>
    </span>
  );
}

export function ActivityPage() {
  const search = useSearch({ strict: false }) as AuditParams;
  const { can } = useMe();
  const users = useUsersLookup(!!search.actorId && can('users:read'));
  const key = useKeyLookup(search.keyId, can('keys:read'));
  const userLabel = users.data?.items.find((u) => u.id === search.actorId)?.email;
  const keyLabel = key.data?.name;
  const navigate = useNavigate();
  const q: AuditParams = { page: 1, pageSize: 50, order: 'desc', ...search };
  const { data, isLoading } = useAudit(q);
  const set = (patch: Partial<AuditParams>) => navigate({ to: '/activity', search: { ...search, page: 1, ...patch } as never, replace: true });
  const sel = 'border-input h-8 rounded-md border bg-transparent px-2 text-sm';
  return (
    <>
      <PageHeader
        title="Activity log"
        description="Every administrative action and sign-in attempt"
        actions={
          <ExportMenu
            path="/admin/audit/export.csv"
            params={{ action: search.action, actor: search.actor, actorType: search.actorType, outcome: search.outcome, actorId: search.actorId, keyId: search.keyId }}
          />
        }
      />
      <div className="flex flex-wrap items-center gap-2 border-b px-8 py-3">
        <select aria-label="Action" className={sel} value={search.action ?? ''} onChange={(e) => set({ action: e.target.value || undefined })}>
          <option value="">All actions</option>
          {data?.actions.map((a) => (
            <option key={a} value={a}>
              {a}
            </option>
          ))}
        </select>
        <select aria-label="Actor type" className={sel} value={search.actorType ?? ''} onChange={(e) => set({ actorType: (e.target.value || undefined) as AuditParams['actorType'] })}>
          <option value="">All actors</option>
          {['user', 'token', 'cli', 'system'].map((a) => (
            <option key={a}>{a}</option>
          ))}
        </select>
        <select aria-label="Outcome" className={sel} value={search.outcome ?? ''} onChange={(e) => set({ outcome: (e.target.value || undefined) as AuditParams['outcome'] })}>
          <option value="">Any outcome</option>
          <option value="success">success</option>
          <option value="failure">failure</option>
        </select>
        <Input placeholder="Actor" className="h-8 w-52" defaultValue={search.actor} onChange={(e) => set({ actor: e.target.value || undefined })} />
        {search.actorId && <ScopeChip label="User" value={userLabel ?? search.actorId.slice(0, 8)} onClear={() => set({ actorId: undefined })} />}
        {search.keyId && <ScopeChip label="API key" value={keyLabel ?? search.keyId.slice(0, 8)} onClear={() => set({ keyId: undefined })} />}
      </div>
      <DataTable
        columns={cols}
        rows={data?.items}
        rowKey={(a) => a.id}
        loading={isLoading}
        total={data?.total}
        page={q.page}
        pageSize={q.pageSize}
        onPage={(page) => navigate({ to: '/activity', search: { ...search, page } as never })}
        empty={{ title: 'No activity matches' }}
      />
    </>
  );
}
