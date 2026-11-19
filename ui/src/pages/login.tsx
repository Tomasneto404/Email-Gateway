// Authored by Tomás Neto (TN 2026)
import { useQueryClient } from '@tanstack/react-query';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { startAuthentication } from '@simplewebauthn/browser';
import { Fingerprint, KeyRound, ShieldCheck } from 'lucide-react';
import { useEffect, useState } from 'react';
import { ApiError, api, call, errorMessage, setCsrfToken, type Schemas } from '@/api/client';
import { useAuthConfig } from '@/api/queries';
import { CopyButton, Field } from '@/components/common/page';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

type Step = { kind: 'credentials' } | { kind: 'enroll'; data?: Schemas['TotpEnrollDto'] } | { kind: 'verify'; methods?: Array<'passkey' | 'totp'> };

export function AuthCard({ title, subtitle, children }: { title: string; subtitle?: string; children: React.ReactNode }) {
  return (
    <div className="bg-background grid min-h-dvh place-items-center px-4 py-16">
      <div className="w-full max-w-sm">
        <div className="mb-6 text-[15px] font-medium">mail-gateway</div>
        <div className="bg-card rounded-xl border p-6 shadow-[0_8px_24px_rgb(0_0_0/0.06)]">
          <h1 className="text-xl leading-7 font-medium">{title}</h1>
          {subtitle && <p className="text-secondary-foreground mt-1 text-sm">{subtitle}</p>}
          <div className="mt-6">{children}</div>
        </div>
      </div>
    </div>
  );
}

export function LoginPage() {
  const search = useSearch({ strict: false }) as { error?: string };
  const cfg = useAuthConfig();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [step, setStep] = useState<Step>({ kind: 'credentials' });
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(search.error ?? null);
  const [busy, setBusy] = useState(false);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(errorMessage(e));
      if (e instanceof ApiError && e.code === 'UNAUTHORIZED' && step.kind !== 'credentials') setStep({ kind: 'credentials' });
    } finally {
      setBusy(false);
    }
  };

  const login = () =>
    run(async () => {
      const r = await call(api.POST('/admin/auth/login', { body: { email, password } }));
      if (r.next === 'done' && r.user && r.csrfToken) {
        setCsrfToken(r.csrfToken);
        qc.setQueryData(['session'], { user: r.user, csrfToken: r.csrfToken });
        navigate({ to: '/' });
        return;
      }
      if (r.next === 'totp_enroll') {
        const data = await call(api.POST('/admin/auth/totp/enroll'));
        setStep({ kind: 'enroll', data });
      } else if (r.next === 'second_factor') setStep({ kind: 'verify', methods: r.methods ?? ['passkey'] });
      else setStep({ kind: 'verify', methods: ['totp'] });
    });

  const passkeyLogin = () =>
    run(async () => {
      const optionsJSON = await call(api.POST('/admin/auth/passkey/options'));
      let response;
      try {
        response = await startAuthentication({ optionsJSON: optionsJSON as never });
      } catch (e) {
        throw new Error((e as Error).name === 'NotAllowedError' ? 'The passkey prompt was cancelled or timed out.' : (e as Error).message);
      }
      const s = await call(api.POST('/admin/auth/passkey/verify', { body: { response: response as never } }));
      setCsrfToken(s.csrfToken);
      qc.setQueryData(['session'], s);
      navigate({ to: '/' });
    });

  const verify = () =>
    run(async () => {
      const s = await call(api.POST('/admin/auth/totp/verify', { body: { code } }));
      setCsrfToken(s.csrfToken);
      qc.setQueryData(['session'], s);
      navigate({ to: '/' });
    });

  if (step.kind === 'credentials') {
    return (
      <AuthCard title="Sign in" subtitle="Administrators only">
        <form
          className="grid gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            login();
          }}
        >
          {cfg.data?.localLogin !== false && (
            <>
              <Field label="Email" htmlFor="email">
                <Input id="email" type="email" autoComplete="username" autoFocus value={email} onChange={(e) => setEmail(e.target.value)} required />
              </Field>
              <Field label="Password" htmlFor="password">
                <Input id="password" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
              </Field>
            </>
          )}
          {error && (
            <p role="alert" className="text-destructive text-sm">
              {error}
            </p>
          )}
          {cfg.data?.localLogin !== false && (
            <Button type="submit" disabled={busy}>
              Continue
            </Button>
          )}
          {cfg.data?.authentik && (
            <>
              {cfg.data.localLogin && <div className="text-muted-foreground text-center text-xs">or</div>}
              <Button asChild variant="outline">
                <a href="/admin/auth/authentik/login">
                  <KeyRound className="size-4" /> Sign in with Authentik
                </a>
              </Button>
            </>
          )}
        </form>
      </AuthCard>
    );
  }

  const methods = step.kind === 'verify' ? (step.methods ?? ['totp']) : ['totp'];
  const withPasskey = methods.includes('passkey');
  const withCode = methods.includes('totp');

  return (
    <AuthCard
      title={step.kind === 'enroll' ? 'Set up two-factor authentication' : 'Two-factor authentication'}
      subtitle={
        step.kind === 'enroll'
          ? 'This gateway requires two-factor authentication. Scan the QR code with an authenticator app (1Password, Authy, Google Authenticator…), then enter the 6-digit code.'
          : withPasskey
            ? withCode
              ? 'Use your passkey, or enter the 6-digit code from your authenticator app.'
              : 'Confirm with your passkey or security key.'
            : 'Enter the 6-digit code from your authenticator app.'
      }
    >
      {withPasskey && (
        <div className="mb-4 grid gap-3">
          <Button onClick={() => void passkeyLogin()} disabled={busy}>
            <Fingerprint className="size-4" /> Use passkey
          </Button>
          {!withCode && error && (
            <p role="alert" className="text-destructive text-sm">
              {error}
            </p>
          )}
          {withCode && <div className="text-muted-foreground text-center text-xs">or</div>}
        </div>
      )}
      {withCode && <form
        className="grid gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          verify();
        }}
      >
        {step.kind === 'enroll' && step.data && (
          <div className="grid justify-items-center gap-2">
            <img src={step.data.qrDataUrl} alt="TOTP QR code" className="size-44 rounded-md border bg-white p-1" />
            <div className="flex w-full items-center gap-2">
              <code data-testid="totp-secret" className="bg-muted min-w-0 flex-1 truncate rounded px-2 py-1 font-mono text-xs">
                {step.data.secret}
              </code>
              <CopyButton value={step.data.secret} label="Copy" />
            </div>
          </div>
        )}
        <Field label="Authentication code" htmlFor="code">
          <Input
            id="code"
            inputMode="numeric"
            autoComplete="one-time-code"
            autoFocus
            maxLength={6}
            pattern="\d{6}"
            className="tabular text-center font-mono text-lg tracking-[0.4em]"
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
          />
        </Field>
        {error && (
          <p role="alert" className="text-destructive text-sm">
            {error}
          </p>
        )}
        <Button type="submit" variant={withPasskey ? 'outline' : 'default'} disabled={busy || code.length !== 6}>
          <ShieldCheck className="size-4" /> Verify
        </Button>
      </form>}
    </AuthCard>
  );
}

export function InvitePage({ token }: { token: string }) {
  const navigate = useNavigate();
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [email, setEmail] = useState<string | null>(null);
  useEffect(() => {
    call(api.GET('/admin/auth/invite/{token}', { params: { path: { token } } }))
      .then((r) => setEmail(r.email))
      .catch((e) => setError(errorMessage(e)));
  }, [token]);
  return (
    <AuthCard title="Set your password" subtitle={email ? `Account: ${email}. You will set up two-factor authentication at first sign-in.` : undefined}>
      <form
        className="grid gap-4"
        onSubmit={async (e) => {
          e.preventDefault();
          if (pw !== pw2) return setError('Passwords do not match.');
          try {
            await call(api.POST('/admin/auth/invite/{token}', { params: { path: { token } }, body: { password: pw } }));
            navigate({ to: '/login', search: { error: undefined } });
          } catch (err) {
            setError(errorMessage(err));
          }
        }}
      >
        <Field label="New password" htmlFor="pw" hint="At least 12 characters">
          <Input id="pw" type="password" autoComplete="new-password" value={pw} onChange={(e) => setPw(e.target.value)} disabled={!email} />
        </Field>
        <Field label="Repeat password" htmlFor="pw2">
          <Input id="pw2" type="password" autoComplete="new-password" value={pw2} onChange={(e) => setPw2(e.target.value)} disabled={!email} />
        </Field>
        {error && (
          <p role="alert" className="text-destructive text-sm">
            {error}
          </p>
        )}
        <Button type="submit" disabled={!email || pw.length < 12}>
          Set password
        </Button>
      </form>
    </AuthCard>
  );
}
