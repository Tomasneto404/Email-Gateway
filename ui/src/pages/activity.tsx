import { useNavigate, useSearch } from '@tanstack/react-router';
import { useAudit, type AuditParams } from '@/api/queries';
import type { Schemas } from '@/api/client';
import { Pill } from '@/components/common/badges';
import { PageHeader } from '@/components/common/page';
import { DataTable, type Column } from '@/components/data-table/data-table';
import { Input } from '@/components/ui/input';
import { fmtDate } from '@/lib/format';

type Entry = Schemas['AuditEntryDto'];

const cols: Column<Entry>[] = [
  { id: 'at', header: 'Time', cell: (a) => <span className="text-muted-foreground text-xs whitespace-nowrap">{fmtDate(a.at)}</span> },
  {
    id: 'actor',
    header: 'Actor',
    cell: (a) => (
      <span className="flex items-center gap-1.5 text-xs">
        <Pill>{a.actorType}</Pill>
        {a.actorLabel}
      </span>
    ),
  },
  { id: 'action', header: 'Action', cell: (a) => <span className="font-mono text-xs">{a.action}</span> },
  { id: 'outcome', header: 'Outcome', cell: (a) => <Pill color={a.outcome === 'success' ? 'green' : 'red'}>{a.outcome}</Pill> },
  {
    id: 'details',
    header: 'Details',
    className: 'max-w-[420px]',
    cell: (a) => (
      <span className="text-muted-foreground block truncate font-mono text-[11px]" title={a.details ? JSON.stringify(a.details) : ''}>
        {a.targetType ? `${a.targetType}:${a.targetId?.slice(-8) ?? ''} ` : ''}
        {a.details ? JSON.stringify(a.details) : ''}
      </span>
    ),
  },
  { id: 'ip', header: 'IP', cell: (a) => <span className="text-muted-foreground font-mono text-xs">{a.ip ?? '—'}</span> },
];

export function ActivityPage() {
  const search = useSearch({ strict: false }) as AuditParams;
  const navigate = useNavigate();
  const q: AuditParams = { page: 1, pageSize: 50, order: 'desc', ...search };
  const { data, isLoading } = useAudit(q);
  const set = (patch: Partial<AuditParams>) => navigate({ to: '/activity', search: { ...search, page: 1, ...patch } as never, replace: true });
  const sel = 'border-input h-8 rounded-md border bg-transparent px-2 text-sm';
  return (
    <>
      <PageHeader title="Activity log" description="Every administrative action and sign-in attempt." />
      <div className="flex flex-wrap items-center gap-2 border-b px-6 py-2">
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
        <Input placeholder="Actor contains…" className="h-8 w-52" defaultValue={search.actor} onChange={(e) => set({ actor: e.target.value || undefined })} />
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
