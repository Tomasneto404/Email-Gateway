// Authored by Tomás Neto (TN 2026)
import { browserSupportsWebAuthn, startRegistration } from '@simplewebauthn/browser';
import { useQueryClient } from '@tanstack/react-query';
import { Fingerprint, Monitor, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { api, call, errorMessage } from '@/api/client';
import { useAccountSessions, useChangePassword, usePasskeys, useRemovePasskey, useRevokeOtherSessions, useRevokeSession } from '@/api/queries';
import { Field } from '@/components/common/page';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useMe } from '@/lib/auth';
import { fmtAgo } from '@/lib/format';

function PasswordTab() {
  const change = useChangePassword();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [repeat, setRepeat] = useState('');
  const mismatch = repeat.length > 0 && next !== repeat;
  const valid = current && next.length >= 12 && next === repeat;
  return (
    <form
      className="grid gap-4"
      onSubmit={async (e) => {
        e.preventDefault();
        await change.mutateAsync({ currentPassword: current, newPassword: next });
        setCurrent('');
        setNext('');
        setRepeat('');
      }}
    >
      <Field label="Current password" htmlFor="pw-current">
        <Input id="pw-current" type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} />
      </Field>
      <Field label="New password" htmlFor="pw-new" hint="At least 12 characters">
        <Input id="pw-new" type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} />
      </Field>
      <Field label="Repeat new password" htmlFor="pw-repeat" error={mismatch ? 'Passwords do not match' : undefined}>
        <Input id="pw-repeat" type="password" autoComplete="new-password" value={repeat} onChange={(e) => setRepeat(e.target.value)} />
      </Field>
      <p className="text-muted-foreground text-xs">Your other sessions are signed out when the password changes.</p>
      <div className="flex justify-end">
        <Button type="submit" disabled={!valid || change.isPending}>
          Change password
        </Button>
      </div>
    </form>
  );
}

function SessionsTab() {
  const sessions = useAccountSessions();
  const revoke = useRevokeSession();
  const others = useRevokeOtherSessions();
  const count = sessions.data?.filter((s) => !s.current).length ?? 0;
  return (
    <div className="grid gap-3">
      <ul className="grid gap-2">
        {sessions.data?.map((s) => (
          <li key={s.id} className="grid grid-cols-[16px_minmax(0,1fr)_auto] items-center gap-3 rounded-lg border px-3 py-2.5">
            <Monitor className="text-muted-foreground size-4" strokeWidth={1.5} />
            <div className="min-w-0">
              <div className="truncate text-sm">
                {browserName(s.userAgent)}
                {s.current && <span className="text-brand ml-2 text-xs">this session</span>}
              </div>
              <div className="text-muted-foreground truncate font-mono text-xs">
                {s.ip ?? 'unknown IP'} · active {fmtAgo(s.lastSeenAt)}
              </div>
            </div>
            {!s.current && (
              <Button size="sm" variant="ghost" onClick={() => revoke.mutate(s.id)}>
                Sign out
              </Button>
            )}
          </li>
        ))}
      </ul>
      {count > 0 && (
        <div className="flex justify-end">
          <Button variant="outline" size="sm" onClick={() => others.mutate()} disabled={others.isPending}>
            Sign out {count} other session{count === 1 ? '' : 's'}
          </Button>
        </div>
      )}
    </div>
  );
}

function PasskeysTab() {
  const passkeys = usePasskeys();
  const remove = useRemovePasskey();
  const qc = useQueryClient();
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const supported = typeof window !== 'undefined' && browserSupportsWebAuthn();

  const add = async () => {
    setBusy(true);
    try {
      const optionsJSON = await call(api.POST('/admin/account/passkeys/options'));
      const response = await startRegistration({ optionsJSON: optionsJSON as never });
      await call(api.POST('/admin/account/passkeys', { body: { response: response as never, name: name.trim() || defaultName() } }));
      toast.success('Passkey added');
      setName('');
      await qc.invalidateQueries({ queryKey: ['account', 'passkeys'] });
      await qc.invalidateQueries({ queryKey: ['session'] });
    } catch (e) {
      const msg = (e as Error).name === 'NotAllowedError' ? 'The passkey prompt was cancelled or timed out' : errorMessage(e);
      toast.error(msg);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="grid gap-4">
      <p className="text-secondary-foreground text-sm">
        A passkey or security key works as a second factor at sign-in, instead of a code from an authenticator app. It needs HTTPS (or localhost).
      </p>
      <ul className="grid gap-2">
        {passkeys.data?.length === 0 && <li className="text-muted-foreground text-sm">No passkeys yet</li>}
        {passkeys.data?.map((p) => (
          <li key={p.id} className="grid grid-cols-[16px_minmax(0,1fr)_auto] items-center gap-3 rounded-lg border px-3 py-2.5">
            <Fingerprint className="text-muted-foreground size-4" strokeWidth={1.5} />
            <div className="min-w-0">
              <div className="truncate text-sm">{p.name}</div>
              <div className="text-muted-foreground font-mono text-xs">{p.lastUsedAt ? `used ${fmtAgo(p.lastUsedAt)}` : `added ${fmtAgo(p.createdAt)}`}</div>
            </div>
            <Button size="icon-sm" variant="ghost" aria-label={`Remove ${p.name}`} onClick={() => remove.mutate(p.id)}>
              <Trash2 />
            </Button>
          </li>
        ))}
      </ul>
      {supported ? (
        <div className="flex items-end gap-2">
          <div className="flex-1">
            <Field label="Name" htmlFor="pk-name">
              <Input id="pk-name" value={name} onChange={(e) => setName(e.target.value)} placeholder={defaultName()} />
            </Field>
          </div>
          <Button onClick={() => void add()} disabled={busy}>
            <Fingerprint /> Add passkey
          </Button>
        </div>
      ) : (
        <p className="text-warning-foreground text-sm">This browser does not support passkeys.</p>
      )}
    </div>
  );
}

function defaultName() {
  const ua = navigator.userAgent;
  const os = /Mac OS X/.test(ua) ? 'Mac' : /Windows/.test(ua) ? 'Windows' : /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iPhone' : /Linux/.test(ua) ? 'Linux' : 'Device';
  return `${browserName(ua)} on ${os}`;
}

function browserName(ua: string | null) {
  if (!ua) return 'Unknown browser';
  if (/Edg\//.test(ua)) return 'Edge';
  if (/Firefox\//.test(ua)) return 'Firefox';
  if (/Chrome\//.test(ua)) return 'Chrome';
  if (/Safari\//.test(ua)) return 'Safari';
  return ua.split(' ')[0].slice(0, 30);
}

/** Password, sessions and passkeys of the signed-in user. */
export function AccountSecurityDialog({ tab, onClose }: { tab: 'password' | 'passkeys' | null; onClose: () => void }) {
  const { user } = useMe();
  const [value, setValue] = useState<string>('password');
  useEffect(() => {
    if (tab) setValue(tab);
  }, [tab]);
  if (!user) return null;
  const local = user.authSource === 'local';
  return (
    <Dialog open={!!tab} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Account security</DialogTitle>
          <DialogDescription>{user.email}</DialogDescription>
        </DialogHeader>
        <Tabs value={value} onValueChange={setValue}>
          <TabsList>
            {local && <TabsTrigger value="password">Password</TabsTrigger>}
            <TabsTrigger value="sessions">Sessions</TabsTrigger>
            {local && <TabsTrigger value="passkeys">Passkeys</TabsTrigger>}
          </TabsList>
          {local && (
            <TabsContent value="password" className="pt-4">
              <PasswordTab />
            </TabsContent>
          )}
          <TabsContent value="sessions" className="pt-4">
            <SessionsTab />
          </TabsContent>
          {local && (
            <TabsContent value="passkeys" className="pt-4">
              <PasskeysTab />
            </TabsContent>
          )}
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}
