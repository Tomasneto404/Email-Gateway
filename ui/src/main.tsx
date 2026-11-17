// Authored by Tomás Neto (TN 2026)
import { MutationCache, QueryCache, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from '@tanstack/react-router';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { ApiError } from '@/api/client';
import { KonamiEasterEgg } from '@/components/easter-egg/konami';
import { Toaster } from '@/components/ui/sonner';
import { TooltipProvider } from '@/components/ui/tooltip';
import { ThemeProvider } from '@/lib/theme';
import { makeRouter } from './router';
import './index.css';

let router: ReturnType<typeof makeRouter>;

/** A 401 anywhere (session expired/revoked) sends the user back to the login page. */
function onAuthError(e: unknown) {
  if (e instanceof ApiError && e.status === 401 && !location.pathname.startsWith('/ui/login')) {
    queryClient.removeQueries({ queryKey: ['session'] });
    router.navigate({ to: '/login', search: { error: 'Your session has expired. Please sign in again.' } });
  }
}

const queryClient = new QueryClient({
  queryCache: new QueryCache({ onError: onAuthError }),
  mutationCache: new MutationCache({ onError: onAuthError }),
  defaultOptions: {
    queries: { retry: (n, e) => !(e instanceof ApiError && e.status < 500) && n < 2, refetchOnWindowFocus: true, staleTime: 5_000 },
  },
});
router = makeRouter(queryClient);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ThemeProvider>
      <QueryClientProvider client={queryClient}>
        <TooltipProvider delayDuration={300}>
          <RouterProvider router={router} />
          <Toaster position="bottom-right" />
          <KonamiEasterEgg />
        </TooltipProvider>
      </QueryClientProvider>
    </ThemeProvider>
  </StrictMode>,
);
