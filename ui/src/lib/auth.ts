import { useQuery } from '@tanstack/react-query';
import { sessionQuery } from '@/api/queries';

export function useMe() {
  const { data } = useQuery(sessionQuery);
  const user = data?.user;
  return { user, isAdmin: user?.role === 'admin', canViewBodies: !!user?.canViewBodies };
}
