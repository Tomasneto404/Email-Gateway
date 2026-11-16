import { Link } from '@tanstack/react-router';
import { PauseCircle, PlayCircle } from 'lucide-react';
import { useState } from 'react';
import { usePauseGateway, useResumeGateway, useStats, useSystemState } from '@/api/queries';
import { Pill } from '@/components/common/badges';
import { PageHeader } from '@/components/common/page';
import { BarList, Legend, StatTile, VolumeChart } from '@/components/dashboard/charts';
import { Segmented } from '@/components/keys/segmented';
import { PauseDialog } from '@/components/layout/app-shell';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { useMe } from '@/lib/auth';
import { fmtAgo, fmtNum } from '@/lib/format';

const RANGES = { '24h': { hours: 24, bucket: 'hour' }, '7d': { hours: 168, bucket: 'day' }, '30d': { hours: 720, bucket: 'day' } } as const;

export function DashboardPage() {
  const { isAdmin } = useMe();
  const [range, setRange] = useState<keyof typeof RANGES>('24h');
  const r = RANGES[range];
  const [from] = useState(() => new Date());
  const stats = useStats({ from: new Date(from.getTime() - r.hours * 3600_000).toISOString(), bucket: r.bucket });
  const sys = useSystemState();
  const pause = usePauseGateway();
  const resume = useResumeGateway();
  const [confirm, setConfirm] = useState(false);
  const g = sys.data?.gateway;
  const t = stats.data?.totals;
  const delivered = t ? t.sent + t.captured : 0;
  const rejectRate = t && t.accepted + t.rejected > 0 ? (t.rejected / (t.accepted + t.rejected)) * 100 : 0;
  const bounces = stats.data?.outcomes.filter((o) => o.outcome === 'bounced' || o.outcome === 'complained').reduce((n, o) => n + o.count, 0) ?? 0;

  return (
    <>
      <PageHeader
        title="Dashboard"
        description="Gateway health and traffic."
        actions={
          <Segmented
            label="Time range"
            size="sm"
            value={range}
            onChange={setRange}
            options={(Object.keys(RANGES) as Array<keyof typeof RANGES>).map((k) => ({ value: k, label: k }))}
          />
        }
      />
      <div className="grid gap-4 p-6">
        <Card className={g?.paused ? 'border-red-500/40' : ''}>
          <CardContent className="flex flex-wrap items-center gap-4">
            {!sys.data ? (
              <Skeleton className="h-8 w-64" />
            ) : (
              <>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className={`size-2.5 rounded-full ${g?.paused ? 'bg-red-500' : 'bg-emerald-500'}`} />
                    <span className="font-semibold" data-testid="gateway-state">
                      {g?.paused ? 'Gateway paused' : 'Gateway running'}
                    </span>
                  </div>
                  {g?.paused && (
                    <p className="text-muted-foreground mt-1 text-sm">
                      {g.reason} · by {g.pausedBy} · {fmtAgo(g.pausedAt)}
                    </p>
                  )}
                </div>
                <div className="flex flex-wrap items-center gap-2 text-xs">
                  {sys.data.breakers.map((b) => (
                    <Pill key={b.provider} color={!b.enabled ? 'gray' : b.state === 'open' ? 'red' : 'green'} dot>
                      {b.provider} {b.enabled ? `breaker ${b.state}` : 'off'}
                    </Pill>
                  ))}
                  <Pill color={sys.data.smtpHealth.status === 'up' ? 'green' : sys.data.smtpHealth.status === 'down' ? 'red' : 'gray'} dot>
                    SMTP {sys.data.smtpHealth.status}
                    {sys.data.smtpHealth.latencyMs !== undefined && ` · ${sys.data.smtpHealth.latencyMs}ms`}
                  </Pill>
                </div>
                {isAdmin &&
                  (g?.paused ? (
                    <Button size="sm" onClick={() => resume.mutate()} disabled={resume.isPending}>
                      <PlayCircle className="size-4" /> Resume
                    </Button>
                  ) : (
                    <Button size="sm" variant="outline" onClick={() => setConfirm(true)}>
                      <PauseCircle className="size-4" /> Pause
                    </Button>
                  ))}
              </>
            )}
          </CardContent>
        </Card>

        <div className="grid grid-cols-2 gap-4 lg:grid-cols-5">
          <StatTile label="Accepted" value={t ? fmtNum(t.accepted) : '—'} hint={`last ${range}`} />
          <StatTile label="Delivered" value={t ? fmtNum(delivered) : '—'} hint={t ? `${fmtNum(t.sent)} live · ${fmtNum(t.captured)} sandbox` : undefined} />
          <StatTile label="Rejected" value={t ? fmtNum(t.rejected) : '—'} hint={`${rejectRate.toFixed(1)}% of requests`} tone={rejectRate > 20 ? 'warn' : undefined} />
          <StatTile label="Failed" value={t ? fmtNum(t.failed) : '—'} tone={t && t.failed > 0 ? 'bad' : undefined} hint={bounces ? `${fmtNum(bounces)} bounces/complaints` : undefined} />
          <StatTile
            label="Queue · approvals"
            value={sys.data ? `${fmtNum(sys.data.queue.waiting + sys.data.queue.active + sys.data.queue.delayed)} · ${fmtNum(sys.data.pendingApprovals)}` : '—'}
            hint={
              sys.data?.pendingApprovals ? (
                <Link to="/approvals" className="text-primary hover:underline">
                  Review approvals →
                </Link>
              ) : (
                'waiting+active+delayed · pending'
              )
            }
          />
        </div>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between">
            <CardTitle className="text-sm">Messages over time</CardTitle>
            <Legend />
          </CardHeader>
          <CardContent>{stats.data ? <VolumeChart series={stats.data.series} bucket={stats.data.bucket} /> : <Skeleton className="h-[220px] w-full" />}</CardContent>
        </Card>

        <div className="grid gap-4 lg:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle className="text-sm">Rejections by reason</CardTitle>
            </CardHeader>
            <CardContent>
              {stats.data ? (
                <BarList items={stats.data.rejectionsByReason.map((x) => ({ label: x.reason, value: x.count }))} emptyTitle="No rejections" />
              ) : (
                <Skeleton className="h-32 w-full" />
              )}
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle className="text-sm">Top keys by volume</CardTitle>
            </CardHeader>
            <CardContent>
              {stats.data ? <BarList items={stats.data.topKeys.map((x) => ({ label: x.name, value: x.count }))} emptyTitle="No traffic yet" /> : <Skeleton className="h-32 w-full" />}
            </CardContent>
          </Card>
        </div>
      </div>
      <PauseDialog open={confirm} onOpenChange={setConfirm} onConfirm={(reason) => pause.mutateAsync(reason || 'manual (admin UI)')} />
    </>
  );
}
