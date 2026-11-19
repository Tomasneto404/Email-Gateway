// Authored by Tomás Neto (TN 2026)
import { format } from 'date-fns';
import { Area, Bar, CartesianGrid, ComposedChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import type { Schemas } from '@/api/client';
import { EmptyState } from '@/components/common/page';
import { fmtNum } from '@/lib/format';
import { cn } from '@/lib/utils';

type Point = Schemas['SeriesPointDto'];

/**
 * Traffic, mirrored on one axis: what left the gateway above the line (delivered = live sent + sandbox
 * captured, in the accent), what the guardrails stopped below it (policy rejections, muted red).
 */
const SERIES = [
  { key: 'delivered', label: 'Delivered', color: 'var(--color-chart-lead)' },
  { key: 'rejected', label: 'Rejected by policy', color: 'var(--color-chart-neg)' },
] as const;

// SVG presentation attributes don't resolve CSS variables, so the family is spelled out.
const MONO = '"Geist Mono Variable", ui-monospace, monospace';
const tick = { fill: 'var(--color-muted-foreground)', fontSize: 12, fontFamily: MONO };

/** 1, 2, 5 × 10^n: the smallest round step that covers v in `parts` steps. */
function niceCeil(v: number, parts = 2) {
  const raw = Math.max(1, v) / parts;
  const p = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 5, 10].map((m) => m * p).find((x) => x >= raw) ?? raw;
  return step * parts;
}

function TooltipBox({ active, payload, label, bucket }: { active?: boolean; payload?: Array<{ payload: Row }>; label?: string; bucket: 'hour' | 'day' }) {
  if (!active || !payload?.length || !label) return null;
  const r = payload[0].payload;
  const rows: Array<[string, number, string]> = [
    ['Delivered', r.delivered, 'var(--color-chart-lead)'],
    ['Rejected', r.rejected, 'var(--color-chart-neg)'],
    ['Accepted', r.accepted, 'var(--color-chart-neutral)'],
  ];
  return (
    <div className="bg-popover text-popover-foreground min-w-40 rounded-md border px-3 py-2 text-xs shadow-[0_8px_24px_rgb(0_0_0/0.08)]">
      <div className="text-muted-foreground mb-1.5 font-mono">{format(new Date(label), bucket === 'hour' ? 'MMM d, HH:00' : 'MMM d')}</div>
      {rows.map(([name, v, c]) => (
        <div key={name} className="flex h-5 items-center justify-between gap-6">
          <span className="text-secondary-foreground flex items-center gap-2">
            <span className="size-2 rounded-full" style={{ background: c }} />
            {name}
          </span>
          <span className="tabular font-mono">{fmtNum(v)}</span>
        </div>
      ))}
    </div>
  );
}

export function Legend() {
  return (
    <div className="text-secondary-foreground flex items-center gap-4 text-xs">
      {SERIES.map((s) => (
        <span key={s.key} className="flex items-center gap-2">
          <span className="size-2 rounded-full" style={{ background: s.color }} />
          {s.label}
        </span>
      ))}
    </div>
  );
}

type Row = { t: string; delivered: number; rejected: number; rejectedNeg: number; accepted: number };

export function VolumeChart({ series, bucket, height = 300 }: { series: Point[] | undefined; bucket: 'hour' | 'day'; height?: number }) {
  const data: Row[] = (series ?? []).map((p) => ({ t: p.t, delivered: p.sent + p.captured, rejected: p.rejected, rejectedNeg: -p.rejected, accepted: p.accepted }));
  if (series && data.every((d) => !d.accepted && !d.rejected && !d.delivered)) {
    return <EmptyState title="No traffic in this range" className="py-12" />;
  }
  const top = niceCeil(Math.max(...data.map((d) => d.delivered), 1));
  const maxRejected = Math.max(0, ...data.map((d) => d.rejected));
  // Same scale on both sides; the lower band never shrinks below half the upper one so a few
  // rejections stay readable instead of collapsing onto the axis.
  const bottom = maxRejected ? niceCeil(Math.max(maxRejected, top / 2), 1) : 0;
  return (
    <div style={{ height }} role="img" aria-label="Messages over time: delivered above the axis, rejected by policy below">
      <ResponsiveContainer>
        <ComposedChart data={data} margin={{ top: 8, right: 4, left: 0, bottom: 0 }} barCategoryGap="30%">
          <defs>
            <linearGradient id="mg-delivered" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--color-chart-lead)" stopOpacity={0.18} />
              <stop offset="100%" stopColor="var(--color-chart-lead)" stopOpacity={0.02} />
            </linearGradient>
          </defs>
          <CartesianGrid vertical={false} stroke="var(--color-border)" />
          <XAxis
            dataKey="t"
            tick={tick}
            tickLine={false}
            axisLine={false}
            minTickGap={40}
            tickMargin={8}
            tickFormatter={(t: string) => format(new Date(t), bucket === 'hour' ? 'HH:mm' : 'MMM d')}
          />
          <YAxis
            tick={tick}
            tickLine={false}
            axisLine={false}
            allowDecimals={false}
            width={36}
            domain={[-bottom, top]}
            ticks={bottom ? [-bottom, 0, top / 2, top] : [0, top / 2, top]}
            tickFormatter={(v: number) => fmtNum(Math.abs(v))}
          />
          <ReferenceLine y={0} stroke="var(--color-muted-foreground)" strokeOpacity={0.4} />
          <Tooltip content={<TooltipBox bucket={bucket} />} cursor={{ fill: 'var(--color-accent)', fillOpacity: 0.6 }} />
          <Bar dataKey="rejectedNeg" fill="var(--color-chart-neg)" fillOpacity={0.55} radius={[0, 0, 2, 2]} maxBarSize={10} isAnimationActive={false} />
          <Area
            type="monotone"
            dataKey="delivered"
            stroke="var(--color-chart-lead)"
            strokeWidth={1.75}
            fill="url(#mg-delivered)"
            dot={false}
            activeDot={{ r: 3.5, strokeWidth: 2, stroke: 'var(--color-card)', fill: 'var(--color-chart-lead)' }}
            isAnimationActive={false}
          />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}

/** A ranked list with thin bars: the leader carries the accent, the rest sit in neutral steps. */
export function BarList({
  items,
  emptyTitle,
  accent = 'lead',
  mono,
}: {
  items: Array<{ label: string; value: number; title?: string }>;
  emptyTitle: string;
  accent?: 'lead' | 'neg';
  mono?: boolean;
}) {
  if (!items.length) return <EmptyState title={emptyTitle} className="py-10" />;
  const max = Math.max(...items.map((i) => i.value));
  return (
    <ol className="grid gap-3">
      {items.map((it, i) => (
        <li key={it.label} className="grid gap-1.5" title={it.title}>
          <div className="flex items-baseline justify-between gap-4 text-sm">
            <span className={cn('min-w-0 truncate', mono && 'font-mono text-xs', i === 0 ? 'text-foreground' : 'text-secondary-foreground')}>{it.label}</span>
            <span className="tabular text-secondary-foreground font-mono text-xs">{fmtNum(it.value)}</span>
          </div>
          <div className="bg-muted h-1 overflow-hidden rounded-full">
            <div
              className={cn('h-full rounded-full', i === 0 ? (accent === 'neg' ? 'bg-chart-neg/70' : 'bg-chart-lead') : 'bg-chart-neutral')}
              style={{ width: `${Math.max(2, (it.value / max) * 100)}%` }}
            />
          </div>
        </li>
      ))}
    </ol>
  );
}

/** "+12% vs previous 24h", "3 fewer vs previous 24h", "no change vs …"; null without data. */
export function changeVs(cur: number | undefined, prev: number | undefined, period: string): string | null {
  if (cur === undefined || prev === undefined) return null;
  if (cur === prev) return `no change vs ${period}`;
  if (prev === 0) return `${fmtNum(cur)} more vs ${period}`;
  const pct = ((cur - prev) / prev) * 100;
  if (Math.abs(pct) < 1000) return `${pct > 0 ? '+' : '−'}${Math.abs(pct) < 10 ? Math.abs(pct).toFixed(1) : Math.round(Math.abs(pct))}% vs ${period}`;
  return `${fmtNum(Math.abs(cur - prev))} ${cur > prev ? 'more' : 'fewer'} vs ${period}`;
}

export function StatTile({ label, value, hint, tone, change }: { label: string; value: React.ReactNode; hint?: React.ReactNode; tone?: 'warn' | 'bad'; change?: string | null }) {
  return (
    <div className="bg-card flex flex-col rounded-xl border px-5 py-4 shadow-[var(--shadow-sm)]">
      <div className="text-secondary-foreground text-sm">{label}</div>
      <div className={cn('tabular mt-2 text-[28px] leading-8 font-medium', tone === 'bad' && 'text-destructive', tone === 'warn' && 'text-warning-foreground')}>{value}</div>
      <div className="text-secondary-foreground tabular mt-1 min-h-4 text-xs leading-4">{change}</div>
      <div className="text-muted-foreground mt-0.5 min-h-4 text-xs leading-4">{hint}</div>
    </div>
  );
}
