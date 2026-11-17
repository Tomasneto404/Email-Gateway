import { useQueryClient } from '@tanstack/react-query';
import { ShieldCheck, ShieldOff } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { api, call, errorMessage, type Schemas } from '@/api/client';
import { useAuthConfig } from '@/api/queries';
import { Pill } from '@/components/common/badges';
import { CopyButton, Field } from '@/components/common/page';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { useMe } from '@/lib/auth';

/** Self-service two-factor authentication (TOTP) for the signed-in user. */
export function TwoFactorDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const { user } = useMe();
  const cfg = useAuthConfig();
  const qc = useQueryClient();
  const [setup, setSetup] = useState<Schemas['TotpEnrollDto'] | null>(null);
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const reset = () => {
    setSetup(null);
    setCode('');
    setPassword('');
    setError(null);
  };
  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  const refresh = () => qc.invalidateQueries({ queryKey: ['session'] });

  if (!user) return null;
  const sso = user.authSource !== 'local';
  const required = !!cfg.data?.totpRequired;

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) reset();
        onOpenChange(o);
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            Two-factor authentication
            {!sso && (user.totpEnrolled ? <Pill color="green" dot>enabled</Pill> : <Pill dot>off</Pill>)}
          </DialogTitle>
          <DialogDescription>
            {sso
              ? 'Your account signs in through Authentik; multi-factor authentication is managed there.'
              : user.totpEnrolled
                ? 'A code from your authenticator app is required at every sign-in.'
                : 'Add a second step to your sign-in with an authenticator app (1Password, Authy, Google Authenticator…). Recommended for administrators.'}
          </DialogDescription>
        </DialogHeader>

        {!sso && !user.totpEnrolled && !setup && (
          <DialogFooter>
            <Button disabled={busy} onClick={() => run(async () => setSetup(await call(api.POST('/admin/account/totp/setup'))))}>
              <ShieldCheck className="size-4" /> Set up authenticator
            </Button>
          </DialogFooter>
        )}

        {!sso && !user.totpEnrolled && setup && (
          <form
            className="grid gap-4"
            onSubmit={(e) => {
              e.preventDefault();
              run(async () => {
                await call(api.POST('/admin/account/totp/confirm', { body: { code } }));
                await refresh();
                toast.success('Two-factor authentication enabled');
                reset();
                onOpenChange(false);
              });
            }}
          >
            <div className="grid justify-items-center gap-2">
              <img src={setup.qrDataUrl} alt="TOTP QR code" className="size-44 rounded-md border bg-white p-1" />
              <div className="flex w-full items-center gap-2">
                <code data-testid="account-totp-secret" className="bg-muted min-w-0 flex-1 truncate rounded px-2 py-1 font-mono text-xs">
                  {setup.secret}
                </code>
                <CopyButton value={setup.secret} />
              </div>
            </div>
            <Field label="Code from the app" htmlFor="totp-confirm" error={error ?? undefined}>
              <Input
                id="totp-confirm"
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={6}
                className="tabular text-center font-mono tracking-[0.3em]"
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
              />
            </Field>
            <DialogFooter>
              <Button type="submit" disabled={busy || code.length !== 6}>
                Enable two-factor
              </Button>
            </DialogFooter>
          </form>
        )}

        {!sso && user.totpEnrolled && (
          required ? (
            <p className="text-muted-foreground text-sm">Required by the gateway policy (TOTP_REQUIRED); it cannot be turned off.</p>
          ) : (
            <form
              className="grid gap-4"
              onSubmit={(e) => {
                e.preventDefault();
                run(async () => {
                  await call(api.POST('/admin/account/totp/disable', { body: { password } }));
                  await refresh();
                  toast.success('Two-factor authentication disabled');
                  reset();
                  onOpenChange(false);
                });
              }}
            >
              <Field label="Current password" htmlFor="totp-disable-pw" hint="Required to turn two-factor off." error={error ?? undefined}>
                <Input id="totp-disable-pw" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
              </Field>
              <DialogFooter>
                <Button type="submit" variant="destructive" disabled={busy || !password}>
                  <ShieldOff className="size-4" /> Disable two-factor
                </Button>
              </DialogFooter>
            </form>
          )
        )}
        {error && !setup && !user.totpEnrolled && (
          <p role="alert" className="text-destructive text-sm">
            {error}
          </p>
        )}
      </DialogContent>
    </Dialog>
  );
}
