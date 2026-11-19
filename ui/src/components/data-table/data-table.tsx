// Authored by Tomás Neto (TN 2026)
import { ArrowDown, ArrowUp, ChevronLeft, ChevronRight, ChevronsUpDown } from 'lucide-react';
import type { ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { EmptyState } from '@/components/common/page';
import { fmtNum } from '@/lib/format';
import { cn } from '@/lib/utils';

export interface Column<T> {
  id: string;
  header: ReactNode;
  cell: (row: T) => ReactNode;
  sortable?: boolean;
  className?: string;
}

interface Props<T> {
  columns: Column<T>[];
  rows: T[] | undefined;
  rowKey: (r: T) => string;
  loading?: boolean;
  total?: number;
  page?: number;
  pageSize?: number;
  onPage?: (p: number) => void;
  sort?: string;
  order?: 'asc' | 'desc';
  onSort?: (id: string, order: 'asc' | 'desc') => void;
  onRowClick?: (r: T) => void;
  selected?: Set<string>;
  onSelectedChange?: (s: Set<string>) => void;
  empty?: { title: string; description?: string };
  activeKey?: string;
}

/** Server-side paginated/sorted table with loading skeleton and empty state. */
export function DataTable<T>(p: Props<T>) {
  const rows = p.rows ?? [];
  const selectable = !!p.onSelectedChange;
  const allSelected = selectable && rows.length > 0 && rows.every((r) => p.selected?.has(p.rowKey(r)));
  const pages = p.total !== undefined && p.pageSize ? Math.max(1, Math.ceil(p.total / p.pageSize)) : 1;
  const toggle = (id: string) => {
    const s = new Set(p.selected);
    if (s.has(id)) s.delete(id);
    else s.add(id);
    p.onSelectedChange?.(s);
  };
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-tour="table">
      <div className="min-h-0 flex-1 overflow-auto">
        <Table>
          <TableHeader className="bg-background sticky top-0 z-10">
            <TableRow>
              {selectable && (
                <TableHead className="w-8 pl-4 sm:pl-8">
                  <Checkbox
                    aria-label="Select all"
                    checked={allSelected}
                    onCheckedChange={(c) => p.onSelectedChange?.(c ? new Set(rows.map(p.rowKey)) : new Set())}
                  />
                </TableHead>
              )}
              {p.columns.map((c, i) => (
                <TableHead key={c.id} className={cn(i === 0 && !selectable && 'pl-4 sm:pl-8', i === p.columns.length - 1 && 'pr-4 sm:pr-8', c.className)}>
                  {c.sortable && p.onSort ? (
                    <button
                      type="button"
                      className="hover:text-foreground inline-flex items-center gap-1"
                      onClick={() => p.onSort!(c.id, p.sort === c.id && p.order === 'desc' ? 'asc' : 'desc')}
                    >
                      {c.header}
                      {p.sort === c.id ? p.order === 'asc' ? <ArrowUp className="size-3.5" /> : <ArrowDown className="size-3.5" /> : <ChevronsUpDown className="size-3.5 opacity-40" />}
                    </button>
                  ) : (
                    c.header
                  )}
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {p.loading && !p.rows
              ? Array.from({ length: 8 }).map((_, i) => (
                  <TableRow key={i}>
                    {selectable && <TableCell className="pl-4 sm:pl-8" />}
                    {p.columns.map((c, j) => (
                      <TableCell key={c.id} className={cn(j === 0 && !selectable && 'pl-4 sm:pl-8')}>
                        <Skeleton className="h-4 w-full max-w-40" />
                      </TableCell>
                    ))}
                  </TableRow>
                ))
              : rows.map((r) => {
                  const id = p.rowKey(r);
                  return (
                    <TableRow
                      key={id}
                      data-state={p.selected?.has(id) || p.activeKey === id ? 'selected' : undefined}
                      className={cn(p.onRowClick && 'cursor-pointer')}
                      onClick={() => p.onRowClick?.(r)}
                    >
                      {selectable && (
                        <TableCell className="pl-4 sm:pl-8" onClick={(e) => e.stopPropagation()}>
                          <Checkbox aria-label="Select row" checked={p.selected?.has(id)} onCheckedChange={() => toggle(id)} />
                        </TableCell>
                      )}
                      {p.columns.map((c, j) => (
                        <TableCell key={c.id} className={cn(j === 0 && !selectable && 'pl-4 sm:pl-8', j === p.columns.length - 1 && 'pr-4 sm:pr-8', c.className)}>
                          {c.cell(r)}
                        </TableCell>
                      ))}
                    </TableRow>
                  );
                })}
          </TableBody>
        </Table>
        {!p.loading && rows.length === 0 && <EmptyState title={p.empty?.title ?? 'Nothing here'} description={p.empty?.description} />}
      </div>
      {p.onPage && p.total !== undefined && (
        <div className="text-muted-foreground flex h-12 shrink-0 items-center justify-between border-t px-4 sm:px-8 text-xs">
          <span className="tabular">{fmtNum(p.total)} total</span>
          <div className="flex items-center gap-2">
            <span className="tabular">
              Page {p.page ?? 1} of {pages}
            </span>
            <Button variant="outline" size="icon" className="size-8" aria-label="Previous page" disabled={(p.page ?? 1) <= 1} onClick={() => p.onPage!((p.page ?? 1) - 1)}>
              <ChevronLeft className="size-4" />
            </Button>
            <Button variant="outline" size="icon" className="size-8" aria-label="Next page" disabled={(p.page ?? 1) >= pages} onClick={() => p.onPage!((p.page ?? 1) + 1)}>
              <ChevronRight className="size-4" />
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
