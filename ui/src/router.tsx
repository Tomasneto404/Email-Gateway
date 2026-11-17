// Authored by Tomás Neto (TN 2026)
import type { QueryClient } from '@tanstack/react-query';
import { Outlet, createRootRouteWithContext, createRoute, createRouter, redirect, useParams } from '@tanstack/react-router';
import { sessionQuery } from '@/api/queries';
import { EmptyState } from '@/components/common/page';
import { AppShell, NAV } from '@/components/layout/app-shell';
import { useMe } from '@/lib/auth';
import { canAny } from '@/lib/permissions';
import { RolesPage } from '@/pages/roles';
import { ActivityPage } from '@/pages/activity';
import { DashboardPage } from '@/pages/dashboard';
import { KeyDetailPage, KeysPage } from '@/pages/keys';
import { InvitePage, LoginPage } from '@/pages/login';
import { ApprovalsPage, MessagesPage } from '@/pages/messages';
import { SettingsPage } from '@/pages/settings';
import { UsersPage } from '@/pages/users';

/** Keeps only known, well-typed search params (URL is the source of truth for table state). */
function pick(allowed: Record<string, 'string' | 'number'>) {
  return (s: Record<string, unknown>) => {
    const out: Record<string, unknown> = {};
    for (const [k, t] of Object.entries(allowed)) {
      const v = s[k];
      if (v === undefined || v === '' || v === null) continue;
      if (t === 'number') {
        const n = Number(v);
        if (Number.isInteger(n) && n > 0) out[k] = n;
      } else out[k] = String(v);
    }
    return out;
  };
}

function NoAccess() {
  return <EmptyState title="No access yet" description="Your account has no permissions. Ask an administrator to assign you a role." className="py-24" />;
}

const rootRoute = createRootRouteWithContext<{ queryClient: QueryClient }>()({ component: Outlet });

const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: 'login',
  validateSearch: (s: Record<string, unknown>): { error?: string } => ({ error: typeof s.error === 'string' ? s.error : undefined }),
  component: LoginPage,
});

const inviteRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: 'invite/$token',
  component: function Invite() {
    const { token } = useParams({ from: '/invite/$token' });
    return <InvitePage token={token} />;
  },
});

const appRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: 'app',
  beforeLoad: async ({ context }) => {
    try {
      const session = await context.queryClient.ensureQueryData(sessionQuery);
      return { session };
    } catch {
      throw redirect({ to: '/login', search: { error: undefined } });
    }
  },
  component: AppShell,
});

/** Route guard: needs ANY of the permissions, otherwise back to the start page. */
const requirePerm =
  (...perms: string[]) =>
  async ({ context }: { context: { queryClient: QueryClient } }) => {
    const s = await context.queryClient.ensureQueryData(sessionQuery);
    if (!canAny(s.user.permissions, perms)) throw redirect({ to: '/' });
  };

/** Start page: the dashboard, or the first screen the user's roles allow. */
const startPage = async ({ context }: { context: { queryClient: QueryClient } }) => {
  const s = await context.queryClient.ensureQueryData(sessionQuery);
  if (canAny(s.user.permissions, ['dashboard:read'])) return;
  const first = NAV.find((n) => canAny(s.user.permissions, n.perms));
  if (first) throw redirect({ to: first.to });
};

const routes = [
  createRoute({
    getParentRoute: () => appRoute,
    path: '/',
    beforeLoad: startPage,
    component: function Start() {
      const { can } = useMe();
      return can('dashboard:read') ? <DashboardPage /> : <NoAccess />;
    },
  }),
  createRoute({
    getParentRoute: () => appRoute,
    path: 'keys',
    validateSearch: pick({ q: 'string', mode: 'string', page: 'number', sort: 'string', order: 'string' }),
    beforeLoad: requirePerm('keys:read'),
    component: KeysPage,
  }),
  createRoute({ getParentRoute: () => appRoute, path: 'keys/$keyId', beforeLoad: requirePerm('keys:read'), component: KeyDetailPage }),
  createRoute({
    getParentRoute: () => appRoute,
    path: 'messages',
    validateSearch: pick({ status: 'string', keyId: 'string', recipient: 'string', subject: 'string', from: 'string', to: 'string', page: 'number', sort: 'string', order: 'string', id: 'string' }),
    beforeLoad: requirePerm('messages:read'),
    component: MessagesPage,
  }),
  createRoute({ getParentRoute: () => appRoute, path: 'approvals', validateSearch: pick({ id: 'string', page: 'number' }), beforeLoad: requirePerm('messages:read'), component: ApprovalsPage }),
  createRoute({ getParentRoute: () => appRoute, path: 'users', beforeLoad: requirePerm('users:read'), component: UsersPage }),
  createRoute({ getParentRoute: () => appRoute, path: 'roles', beforeLoad: requirePerm('users:read', 'roles:manage'), component: RolesPage }),
  createRoute({
    getParentRoute: () => appRoute,
    path: 'activity',
    validateSearch: pick({ action: 'string', actor: 'string', actorType: 'string', outcome: 'string', actorId: 'string', keyId: 'string', page: 'number' }),
    beforeLoad: requirePerm('audit:read'),
    component: ActivityPage,
  }),
  createRoute({ getParentRoute: () => appRoute, path: 'settings', beforeLoad: requirePerm('settings:read'), component: SettingsPage }),
];

const routeTree = rootRoute.addChildren([loginRoute, inviteRoute, appRoute.addChildren(routes)]);

export function makeRouter(queryClient: QueryClient) {
  return createRouter({ routeTree, basepath: '/ui', context: { queryClient }, defaultPreload: 'intent', scrollRestoration: true });
}

declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof makeRouter>;
  }
}
