import { format } from 'date-fns';
import { Area, AreaChart, Bar, BarChart, CartesianGrid, LabelList, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import type { Schemas } from '@/api/client';
import { EmptyState } from '@/components/common/page';
import { fmtNum } from '@/lib/format';

type Point = Schemas['SeriesPointDto'];

/** Max three series, fixed categorical order (validated palette slots 1-3). */
const SERIES = [
  { key: 'accepted', label: 'Accepted', color: 'var(--color-chart-1)' },
  { key: 'rejected', label: 'Rejected', color: 'var(--color-chart-2)' },
  { key: 'delivered', label: 'Delivered', color: 'var(--color-chart-3)' },
] as const;

const axis = { stroke: 'var(--color-muted-foreground)', fontSize: 11, tickLine: false, axisLine: false };

function TooltipBox({ active, payload, label, bucket }: { active?: boolean; payload?: Array<{ dataKey: string; value: number; color: string }>; label?: string; bucket: 'hour' | 'day' }) {
  if (!active || !payload?.length || !label) return null;
  return (
    <div className="bg-popover text-popover-foreground min-w-36 rounded-md border px-2.5 py-2 text-xs shadow-md">
      <div className="text-muted-foreground mb-1">{format(new Date(label), bucket === 'hour' ? 'MMM d, HH:00' : 'MMM d')}</div>
      {payload.map((p) => (
        <div key={p.dataKey} className="flex items-center justify-between gap-4">
          <span className="flex items-center gap-1.5">
            <span className="size-2 rounded-sm" style={{ background: p.color }} />
            {SERIES.find((s) => s.key === p.dataKey)?.label}
          </span>
          <span className="tabular font-medium">{fmtNum(p.value)}</span>
        </div>
      ))}
    </div>
  );
}

export function Legend() {
  return (
    <div className="text-muted-foreground flex items-center gap-3 text-xs">
      {SERIES.map((s) => (
        <span key={s.key} className="flex items-center gap-1.5">
          <span className="size-2 rounded-sm" style={{ background: s.color }} />
          {s.label}
        </span>
      ))}
    </div>
  );
}

/** Volume over time: accepted vs rejected vs delivered (sent + sandbox captured). */
export function VolumeChart({ series, bucket, height = 220 }: { series: Point[] | undefined; bucket: 'hour' | 'day'; height?: number }) {
  const data = (series ?? []).map((p) => ({ t: p.t, accepted: p.accepted, rejected: p.rejected, delivered: p.sent + p.captured }));
  if (series && data.every((d) => !d.accepted && !d.rejected && !d.delivered)) {
    return <EmptyState title="No traffic in this range" className="py-10" />;
  }
  return (
    <div style={{ height }} role="img" aria-label="Messages over time: accepted, rejected and delivered">
      <ResponsiveContainer>
        <AreaChart data={data} margin={{ top: 8, right: 8, left: -16, bottom: 0 }}>
          <CartesianGrid vertical={false} stroke="var(--color-border)" />
          <XAxis dataKey="t" {...axis} minTickGap={32} tickFormatter={(t: string) => format(new Date(t), bucket === 'hour' ? 'HH:mm' : 'MMM d')} />
          <YAxis {...axis} allowDecimals={false} width={48} />
          <Tooltip content={<TooltipBox bucket={bucket} />} cursor={{ stroke: 'var(--color-muted-foreground)', strokeDasharray: '3 3' }} />
          {SERIES.map((s) => (
            <Area key={s.key} type="linear" dataKey={s.key} stroke={s.color} strokeWidth={2} fill={s.color} fillOpacity={0.08} dot={false} activeDot={{ r: 4, strokeWidth: 2, stroke: 'var(--color-card)' }} isAnimationActive={false} />
          ))}
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

/** Single-series horizontal bars with direct value labels. */
export function BarList({ items, emptyTitle }: { items: Array<{ label: string; value: number }>; emptyTitle: string }) {
  if (!items.length) return <EmptyState title={emptyTitle} className="py-8" />;
  const h = Math.max(120, items.length * 30);
  return (
    <div style={{ height: h }}>
      <ResponsiveContainer>
        <BarChart data={items} layout="vertical" margin={{ top: 0, right: 40, left: 0, bottom: 0 }} barCategoryGap={6}>
          <XAxis type="number" hide />
          <YAxis type="category" dataKey="label" {...axis} width={170} tick={{ fontSize: 11, fill: 'var(--color-foreground)' }} />
          <Tooltip
            cursor={{ fill: 'var(--color-accent)' }}
            content={({ active, payload }) =>
              active && payload?.[0] ? (
                <div className="bg-popover rounded-md border px-2 py-1 text-xs shadow-md">
                  {String(payload[0].payload.label)}: <b className="tabular">{fmtNum(Number(payload[0].value))}</b>
                </div>
              ) : null
            }
          />
          <Bar dataKey="value" fill="var(--color-chart-1)" radius={[0, 4, 4, 0]} isAnimationActive={false}>
            <LabelList dataKey="value" position="right" className="fill-foreground text-[11px]" formatter={(v: unknown) => fmtNum(Number(v))} />
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

export function StatTile({ label, value, hint, tone }: { label: string; value: React.ReactNode; hint?: React.ReactNode; tone?: 'warn' | 'bad' }) {
  return (
    <div className="bg-card rounded-lg border p-4">
      <div className="text-muted-foreground text-xs font-medium">{label}</div>
      <div className={`tabular mt-1 text-2xl font-semibold tracking-tight ${tone === 'bad' ? 'text-destructive' : tone === 'warn' ? 'text-amber-600 dark:text-amber-400' : ''}`}>{value}</div>
      {hint && <div className="text-muted-foreground mt-0.5 text-xs">{hint}</div>}
    </div>
  );
}
