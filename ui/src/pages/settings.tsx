import { ExternalLink } from 'lucide-react';
import { useSettings } from '@/api/queries';
import { Signal } from '@/components/common/badges';
import { KV, PageHeader } from '@/components/common/page';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { fmtBytes } from '@/lib/format';

const onOff = (b: boolean) => (
  <Signal tone={b ? 'green' : 'gray'} hollow={!b} className={b ? undefined : 'text-secondary-foreground'}>
    {b ? 'enabled' : 'disabled'}
  </Signal>
);

export function SettingsPage() {
  const { data: s } = useSettings();
  return (
    <>
      <PageHeader title="Settings" description="Effective configuration, read-only. Change it through environment variables; secrets are never shown" />
      {!s ? (
        <div className="px-8 py-6">
          <Skeleton className="h-48 w-full" />
        </div>
      ) : (
        <div className="grid w-full max-w-[1440px] gap-4 px-8 py-6 lg:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle>Live delivery</CardTitle>
            </CardHeader>
            <CardContent>
              <KV
                items={[
                  ['Default provider', <span className="font-mono text-xs">{s.liveProvider}</span>],
                  ['SMTP', onOff(s.smtp.enabled)],
                  ['SMTP target', s.smtp.host ? <span className="font-mono text-xs">{`${s.smtp.host}:${s.smtp.port}`}</span> : '—'],
                  ['TLS', s.smtp.secure ? 'implicit TLS' : s.smtp.requireTls ? 'STARTTLS required' : 'opportunistic'],
                  ['SMTP auth', s.smtp.authConfigured ? 'configured (password hidden)' : 'none'],
                  ['Resend', onOff(s.resend.enabled)],
                  ['Resend webhook', onOff(s.resend.webhookConfigured)],
                  [
                    'System email (invites)',
                    s.systemMail.enabled ? (
                      <span className="text-xs">
                        <Signal tone="green">enabled</Signal> {s.systemMail.from} via {s.systemMail.provider}
                      </span>
                    ) : (
                      <span className="text-muted-foreground text-xs">off: set SYSTEM_MAIL_FROM</span>
                    ),
                  ],
                ]}
              />
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>Sandbox</CardTitle>
            </CardHeader>
            <CardContent>
              <KV
                items={[
                  ['Mailpit SMTP', <span className="font-mono text-xs">{s.mailpitSmtp}</span>],
                  [
                    'Mailpit UI',
                    s.mailpitUiUrl ? (
                      <a href={s.mailpitUiUrl} target="_blank" rel="noreferrer" className="text-brand inline-flex items-center gap-1 hover:underline">
                        {s.mailpitUiUrl} <ExternalLink className="size-3" />
                      </a>
                    ) : (
                      'not exposed'
                    ),
                  ],
                ]}
              />
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>Guardrails</CardTitle>
            </CardHeader>
            <CardContent>
              <KV
                items={[
                  ['Global delivery rate', `${s.globalRateMax} / ${s.globalRateDurationMs} ms`],
                  ['Global accept cap', `${s.globalAcceptPerHour} / hour`],
                  ['Dedup window', `${s.dedupWindowSeconds} s`],
                  ['Idempotency window', `${s.idempotencyTtlSeconds / 3600} h`],
                  ['Delivery attempts', String(s.deliveryMaxAttempts)],
                  ['Circuit breaker', `${s.breakerConsecutiveFailures} consecutive or ≥${Math.round(s.breakerFailureRate * 100)}% in ${s.breakerWindowSeconds}s`],
                  ['Max request', fmtBytes(s.maxRequestBytes)],
                  ['Trust proxy', <span className="font-mono text-xs">{s.trustProxy}</span>],
                ]}
              />
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>Retention & access</CardTitle>
            </CardHeader>
            <CardContent>
              <KV
                items={[
                  ['Message bodies', `${s.bodyRetentionDays} days`],
                  ['Audit records', `${s.recordRetentionDays} days`],
                  ['Retention job', <span className="font-mono text-xs">{s.retentionCron} (UTC)</span>],
                  ['Local login', onOff(s.localLogin)],
                  ['Two-factor (TOTP)', s.totpRequired ? 'required for local users' : 'optional, per user'],
                  ['Static admin token', onOff(s.adminTokenEnabled)],
                  ['Session', `${s.sessionTtlHours} h max · ${s.sessionIdleMinutes} min idle`],
                  ['Authentik SSO', onOff(s.authentik.enabled)],
                  ...(s.authentik.enabled
                    ? ([
                        ['Issuer', <span className="font-mono text-xs">{s.authentik.issuer}</span>],
                        ['Groups claim', <span className="font-mono text-xs">{s.authentik.groupsClaim}</span>],
                        ['Group → role mapping', <span className="text-xs">configured per role on the Roles page</span>],
                      ] as Array<[string, React.ReactNode]>)
                    : []),
                ]}
              />
            </CardContent>
          </Card>
        </div>
      )}
    </>
  );
}
