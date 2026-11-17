import { useQuery } from '@tanstack/react-query';
import { sessionQuery } from '@/api/queries';
import { canAny, hasPermission } from './permissions';

/** Signed-in user + RBAC helpers. UI gating only — every action is authorized server-side. */
export function useMe() {
  const { data } = useQuery(sessionQuery);
  const user = data?.user;
  const perms = user?.permissions;
  return {
    user,
    can: (p: string) => hasPermission(perms, p),
    canAny: (...p: string[]) => canAny(perms, p),
    isSuperAdmin: !!perms?.includes('*'),
  };
}
