import { MoreHorizontal, UserPlus } from 'lucide-react';
import { useState } from 'react';
import { useDeleteUser, useInviteUser, useResetAccess, useResetTotp, useUpdateUser, useUsers, type User } from '@/api/queries';
import { Pill } from '@/components/common/badges';
import { CopyButton, Field, PageHeader } from '@/components/common/page';
import { ConfirmDialog } from '@/components/confirm/confirm-dialog';
import { DataTable, type Column } from '@/components/data-table/data-table';
import { Segmented } from '@/components/keys/segmented';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { useMe } from '@/lib/auth';
import { fmtAgo } from '@/lib/format';
import { isEmail } from '@/lib/schemas';

function InviteLink({ path, hours }: { path: string; hours: number }) {
  const url = `${window.location.origin}${path}`;
  return (
    <div className="grid gap-2">
      <p className="text-sm">Share this one-time link with the user (valid {hours}h, shown once). They set a password, then enroll TOTP at first sign-in.</p>
      <div className="bg-muted flex items-center gap-2 rounded-md border p-2">
        <code data-testid="invite-link" className="min-w-0 flex-1 truncate font-mono text-xs">
          {url}
        </code>
        <CopyButton value={url} />
      </div>
    </div>
  );
}

function InviteDialog() {
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [role, setRole] = useState<'admin' | 'viewer'>('viewer');
  const [bodies, setBodies] = useState(false);
  const [result, setResult] = useState<{ invitePath: string; expiresInHours: number } | null>(null);
  const invite = useInviteUser();
  return (
    <>
      <Button size="sm" onClick={() => setOpen(true)}>
        <UserPlus className="size-4" /> Invite user
      </Button>
      <Dialog
        open={open}
        onOpenChange={(o) => {
          setOpen(o);
          if (!o) {
            setResult(null);
            setEmail('');
            setName('');
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Invite admin user</DialogTitle>
            <DialogDescription>Local account with password + mandatory TOTP. SSO users are provisioned automatically from Authentik groups.</DialogDescription>
          </DialogHeader>
          {result ? (
            <InviteLink path={result.invitePath} hours={result.expiresInHours} />
          ) : (
            <div className="grid gap-3">
              <Field label="Email" htmlFor="u-email">
                <Input id="u-email" value={email} onChange={(e) => setEmail(e.target.value)} />
              </Field>
              <Field label="Name" htmlFor="u-name">
                <Input id="u-name" value={name} onChange={(e) => setName(e.target.value)} />
              </Field>
              <Field label="Role">
                <Segmented label="Role" value={role} onChange={setRole} options={[{ value: 'viewer', label: 'Viewer (read-only)' }, { value: 'admin', label: 'Admin' }]} />
              </Field>
              {role === 'viewer' && (
                <label className="flex items-center justify-between rounded-md border p-3 text-sm">
                  Can view message bodies
                  <Switch checked={bodies} onCheckedChange={setBodies} />
                </label>
              )}
            </div>
          )}
          <DialogFooter>
            {result ? (
              <Button onClick={() => setOpen(false)}>Done</Button>
            ) : (
              <Button
                disabled={!isEmail(email) || invite.isPending}
                onClick={async () => setResult(await invite.mutateAsync({ email, name, role, canViewBodies: role === 'viewer' ? bodies : undefined }))}
              >
                Create invite
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

export function UsersPage() {
  const { user: me } = useMe();
  const { data, isLoading } = useUsers();
  const update = useUpdateUser();
  const resetTotp = useResetTotp();
  const resetAccess = useResetAccess();
  const del = useDeleteUser();
  const [confirm, setConfirm] = useState<{ kind: 'disable' | 'delete' | 'totp' | 'access' | 'role'; user: User } | null>(null);
  const [link, setLink] = useState<{ invitePath: string; expiresInHours: number } | null>(null);

  const cols: Column<User>[] = [
    {
      id: 'email',
      header: 'User',
      cell: (u) => (
        <div>
          <div className="font-medium">{u.email}</div>
          {u.name && <div className="text-muted-foreground text-xs">{u.name}</div>}
        </div>
      ),
    },
    {
      id: 'role',
      header: 'Role',
      cell: (u) => (
        <span className="flex gap-1">
          <Pill color={u.role === 'admin' ? 'violet' : 'gray'}>{u.role}</Pill>
          {u.role === 'viewer' && u.canViewBodies && <Pill color="blue">bodies</Pill>}
        </span>
      ),
    },
    { id: 'source', header: 'Sign-in', cell: (u) => (u.authSource === 'authentik' ? <Pill color="blue">Authentik SSO</Pill> : <Pill>local{u.totpEnrolled ? ' · TOTP' : ''}</Pill>) },
    {
      id: 'state',
      header: 'Status',
      cell: (u) =>
        u.disabled ? <Pill color="red">disabled</Pill> : u.locked ? <Pill color="amber">locked</Pill> : u.pendingInvite ? <Pill color="amber">invited</Pill> : <Pill color="green">active</Pill>,
    },
    { id: 'last', header: 'Last sign-in', cell: (u) => <span className="text-muted-foreground text-xs">{fmtAgo(u.lastLoginAt)}</span> },
    {
      id: 'actions',
      header: '',
      className: 'text-right pr-6',
      cell: (u) =>
        u.id === me?.id ? (
          <span className="text-muted-foreground text-xs">you</span>
        ) : (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="icon" variant="ghost" className="size-7" aria-label={`Actions for ${u.email}`}>
                <MoreHorizontal className="size-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {u.authSource === 'local' && (
                <>
                  <DropdownMenuItem onClick={() => setConfirm({ kind: 'role', user: u })}>Make {u.role === 'admin' ? 'viewer' : 'admin'}…</DropdownMenuItem>
                  {u.role === 'viewer' && (
                    <DropdownMenuItem onClick={() => update.mutate({ id: u.id, body: { canViewBodies: !u.canViewBodies } })}>
                      {u.canViewBodies ? 'Hide message bodies' : 'Allow message bodies'}
                    </DropdownMenuItem>
                  )}
                  <DropdownMenuItem onClick={() => setConfirm({ kind: 'totp', user: u })}>Reset 2FA…</DropdownMenuItem>
                  <DropdownMenuItem onClick={() => setConfirm({ kind: 'access', user: u })}>Reset password (new invite)…</DropdownMenuItem>
                </>
              )}
              {u.disabled ? (
                <DropdownMenuItem onClick={() => update.mutate({ id: u.id, body: { disabled: false } })}>Enable</DropdownMenuItem>
              ) : (
                <DropdownMenuItem onClick={() => setConfirm({ kind: 'disable', user: u })}>Disable…</DropdownMenuItem>
              )}
              <DropdownMenuSeparator />
              <DropdownMenuItem variant="destructive" onClick={() => setConfirm({ kind: 'delete', user: u })}>
                Delete…
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        ),
    },
  ];

  const c = confirm;
  const texts = {
    disable: { title: 'Disable user?', desc: 'They are signed out immediately and cannot sign in.', label: 'Disable' },
    delete: { title: 'Delete user?', desc: 'The account is removed. Activity log entries are kept.', label: 'Delete' },
    totp: { title: 'Reset two-factor authentication?', desc: 'They are signed out and must enroll a new authenticator at next sign-in.', label: 'Reset 2FA' },
    access: { title: 'Reset password?', desc: 'Password and TOTP are cleared, sessions revoked, and a new invite link is generated.', label: 'Reset access' },
    role: { title: 'Change role?', desc: 'They are signed out so the new role applies immediately.', label: 'Change role' },
  };

  return (
    <>
      <PageHeader title="Admin users" description="Who can manage the gateway." actions={<InviteDialog />} />
      <DataTable columns={cols} rows={data?.items} rowKey={(u) => u.id} loading={isLoading} total={data?.total} empty={{ title: 'No users' }} />
      {c && (
        <ConfirmDialog
          open
          onOpenChange={(o) => !o && setConfirm(null)}
          title={texts[c.kind].title}
          description={<>{c.user.email}: {texts[c.kind].desc}</>}
          confirmLabel={texts[c.kind].label}
          destructive={c.kind !== 'role'}
          typeToConfirm={c.kind === 'delete' ? c.user.email : undefined}
          onConfirm={async () => {
            if (c.kind === 'disable') await update.mutateAsync({ id: c.user.id, body: { disabled: true } });
            if (c.kind === 'role') await update.mutateAsync({ id: c.user.id, body: { role: c.user.role === 'admin' ? 'viewer' : 'admin' } });
            if (c.kind === 'delete') await del.mutateAsync(c.user.id);
            if (c.kind === 'totp') await resetTotp.mutateAsync(c.user.id);
            if (c.kind === 'access') setLink(await resetAccess.mutateAsync(c.user.id));
          }}
        />
      )}
      <Dialog open={!!link} onOpenChange={(o) => !o && setLink(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>New invite link</DialogTitle>
          </DialogHeader>
          {link && <InviteLink path={link.invitePath} hours={link.expiresInHours} />}
        </DialogContent>
      </Dialog>
    </>
  );
}
