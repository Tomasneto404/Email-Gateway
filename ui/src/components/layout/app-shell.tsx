import { useQueryClient } from '@tanstack/react-query';
import { Link, Outlet, useNavigate, useRouterState } from '@tanstack/react-router';
import {
  Activity,
  BookOpen,
  CheckCheck,
  KeyRound,
  LayoutDashboard,
  LogOut,
  Mail,
  Monitor,
  Moon,
  PauseCircle,
  PlayCircle,
  Search,
  Settings,
  Sun,
  Users,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import { api, call, setCsrfToken } from '@/api/client';
import { usePauseGateway, useResumeGateway, useSystemState } from '@/api/queries';
import { ConfirmDialog } from '@/components/confirm/confirm-dialog';
import { CommandDialog, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '@/components/ui/command';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { useMe } from '@/lib/auth';
import { useTheme } from '@/lib/theme';
import { cn } from '@/lib/utils';

const NAV = [
  { to: '/', label: 'Dashboard', icon: LayoutDashboard, key: 'g d' },
  { to: '/keys', label: 'API keys', icon: KeyRound, key: 'g k' },
  { to: '/messages', label: 'Messages', icon: Mail, key: 'g m' },
  { to: '/approvals', label: 'Approvals', icon: CheckCheck, key: 'g a' },
  { to: '/users', label: 'Admin users', icon: Users, key: 'g u', admin: true },
  { to: '/activity', label: 'Activity log', icon: Activity, key: 'g l' },
  { to: '/settings', label: 'Settings', icon: Settings, key: 'g s' },
] as const;

export function GatewayPill() {
  const { data } = useSystemState();
  if (!data) return null;
  const open = data.breakers.some((b) => b.state === 'open');
  return (
    <span
      data-testid="gateway-pill"
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium',
        data.gateway.paused ? 'bg-red-500/12 text-red-700 dark:text-red-300' : 'bg-emerald-500/12 text-emerald-700 dark:text-emerald-300',
      )}
      title={data.gateway.reason ?? undefined}
    >
      <span className="size-1.5 rounded-full bg-current" />
      {data.gateway.paused ? (open ? 'Paused · breaker open' : 'Paused') : 'Running'}
    </span>
  );
}

export function AppShell() {
  const { user, isAdmin } = useMe();
  const { data: sys } = useSystemState();
  const path = useRouterState({ select: (s) => s.location.pathname });
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { theme, setTheme } = useTheme();
  const [cmd, setCmd] = useState(false);
  const [confirmPause, setConfirmPause] = useState(false);
  const pause = usePauseGateway();
  const resume = useResumeGateway();

  // ⌘K / Ctrl+K palette and "g x" chords
  useEffect(() => {
    let g = false;
    let t: ReturnType<typeof setTimeout>;
    const onKey = (e: KeyboardEvent) => {
      const typing = e.target instanceof HTMLElement && (e.target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName));
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setCmd((o) => !o);
        return;
      }
      if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === 'g') {
        g = true;
        clearTimeout(t);
        t = setTimeout(() => (g = false), 800);
        return;
      }
      if (g) {
        const n = NAV.find((x) => x.key === `g ${e.key}`);
        if (n && (!('admin' in n) || isAdmin)) navigate({ to: n.to });
        g = false;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [navigate, isAdmin]);

  const logout = async () => {
    const r = await call(api.POST('/admin/auth/logout')).catch(() => ({ redirect: null }));
    setCsrfToken(null);
    qc.clear();
    if (r.redirect) window.location.href = r.redirect;
    else navigate({ to: '/login', search: { error: undefined } });
  };

  const isActive = (to: string) => (to === '/' ? path === '/ui/' || path === '/ui' || path === '/' : path.includes(to));

  return (
    <div className="flex h-dvh overflow-hidden">
      <aside className="bg-sidebar hidden w-56 shrink-0 flex-col border-r md:flex">
        <div className="flex h-12 items-center gap-2 px-4 font-semibold tracking-tight">
          <Mail className="text-primary size-4" /> mail-gateway
        </div>
        <button
          onClick={() => setCmd(true)}
          className="text-muted-foreground hover:bg-accent mx-3 mb-2 flex items-center gap-2 rounded-md border px-2 py-1.5 text-xs"
        >
          <Search className="size-3.5" /> Search…
          <kbd className="bg-muted ml-auto rounded px-1 font-mono text-[10px]">⌘K</kbd>
        </button>
        <nav className="grid gap-0.5 px-2">
          {NAV.filter((n) => !('admin' in n) || isAdmin).map((n) => (
            <Link
              key={n.to}
              to={n.to}
              className={cn(
                'flex items-center gap-2 rounded-md px-2 py-1.5 text-sm',
                isActive(n.to) ? 'bg-accent text-foreground font-medium' : 'text-muted-foreground hover:bg-accent/60 hover:text-foreground',
              )}
            >
              <n.icon className="size-4" />
              {n.label}
              {n.to === '/approvals' && !!sys?.pendingApprovals && (
                <span className="bg-primary text-primary-foreground ml-auto rounded-full px-1.5 text-[10px] font-semibold tabular">{sys.pendingApprovals}</span>
              )}
            </Link>
          ))}
        </nav>
        <a
          href="/docs"
          target="_blank"
          rel="noreferrer"
          className="text-muted-foreground hover:bg-accent/60 hover:text-foreground mx-2 mt-auto flex items-center gap-2 rounded-md px-2 py-1.5 text-sm"
        >
          <BookOpen className="size-4" /> API docs
        </a>
        <div className="border-t p-2">
          <DropdownMenu>
            <DropdownMenuTrigger className="hover:bg-accent flex w-full items-center gap-2 rounded-md p-2 text-left text-sm">
              <span className="bg-primary/15 text-primary grid size-6 place-items-center rounded-full text-xs font-semibold uppercase">{user?.email[0]}</span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-xs font-medium" data-testid="current-user">{user?.email}</span>
                <span className="text-muted-foreground block text-[11px]">{user?.role}</span>
              </span>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-52">
              <DropdownMenuLabel className="text-xs">Theme</DropdownMenuLabel>
              <DropdownMenuItem onClick={() => setTheme('light')}>
                <Sun className="size-4" /> Light {theme === 'light' && '✓'}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => setTheme('dark')}>
                <Moon className="size-4" /> Dark {theme === 'dark' && '✓'}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => setTheme('system')}>
                <Monitor className="size-4" /> System {theme === 'system' && '✓'}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={logout}>
                <LogOut className="size-4" /> Log out
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </aside>
      <main className="flex min-w-0 flex-1 flex-col">
        <div className="flex h-12 shrink-0 items-center gap-3 border-b px-6 md:hidden">
          <Mail className="text-primary size-4" />
          <span className="font-semibold">mail-gateway</span>
          <div className="ml-auto flex gap-1">
            {NAV.filter((n) => !('admin' in n) || isAdmin).map((n) => (
              <Link key={n.to} to={n.to} className="text-muted-foreground p-1.5" aria-label={n.label}>
                <n.icon className="size-4" />
              </Link>
            ))}
          </div>
        </div>
        <div className="flex min-h-0 flex-1 flex-col overflow-auto">
          <Outlet />
        </div>
      </main>

      <CommandDialog open={cmd} onOpenChange={setCmd}>
        <CommandInput placeholder="Jump to… or run a command" />
        <CommandList>
          <CommandEmpty>No results.</CommandEmpty>
          <CommandGroup heading="Navigate">
            {NAV.filter((n) => !('admin' in n) || isAdmin).map((n) => (
              <CommandItem
                key={n.to}
                onSelect={() => {
                  setCmd(false);
                  navigate({ to: n.to });
                }}
              >
                <n.icon className="size-4" /> {n.label}
                <span className="text-muted-foreground ml-auto font-mono text-[10px]">{n.key}</span>
              </CommandItem>
            ))}
          </CommandGroup>
          {isAdmin && sys && (
            <CommandGroup heading="Gateway">
              {sys.gateway.paused ? (
                <CommandItem
                  onSelect={() => {
                    setCmd(false);
                    resume.mutate();
                  }}
                >
                  <PlayCircle className="size-4" /> Resume gateway
                </CommandItem>
              ) : (
                <CommandItem
                  onSelect={() => {
                    setCmd(false);
                    setConfirmPause(true);
                  }}
                >
                  <PauseCircle className="size-4" /> Pause gateway…
                </CommandItem>
              )}
            </CommandGroup>
          )}
          <CommandGroup heading="Theme">
            <CommandItem onSelect={() => setTheme(theme === 'dark' ? 'light' : 'dark')}>
              <Moon className="size-4" /> Toggle dark mode
            </CommandItem>
          </CommandGroup>
        </CommandList>
      </CommandDialog>
      <PauseDialog open={confirmPause} onOpenChange={setConfirmPause} onConfirm={(r) => pause.mutateAsync(r || 'manual (admin UI)')} />
    </div>
  );
}

export function PauseDialog({ open, onOpenChange, onConfirm }: { open: boolean; onOpenChange: (o: boolean) => void; onConfirm: (reason: string) => Promise<unknown> }) {
  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Pause the gateway?"
      description="All API sends will be rejected with GATEWAY_PAUSED and queued deliveries stop until you resume."
      confirmLabel="Pause gateway"
      destructive
      reasonLabel="Reason (shown in the activity log)"
      onConfirm={async (r) => {
        await onConfirm(r);
      }}
    />
  );
}
