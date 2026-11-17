// Authored by Tomás Neto (TN 2026)
import { useNavigate } from '@tanstack/react-router';
import { Route as RouteIcon, X } from 'lucide-react';
import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { useMe } from '@/lib/auth';
import { cn } from '@/lib/utils';
import { cardPosition, spotlightBox, type Box } from './position';
import { TOUR_STEPS, type TourStep } from './steps';

/*
 * Guided tour. Elements opt in with `data-tour="<name>"`; each step can open a route first, waits
 * for its target and skips it when it never shows up (missing permission, small screen).
 * Completion is remembered per user in localStorage, which is only a convenience: when storage is
 * unavailable the sidebar simply offers the tour again.
 */

type Ctx = { start: () => void; dismiss: () => void; active: boolean; seen: boolean };
const TourContext = createContext<Ctx | null>(null);

export function useTour() {
  const c = useContext(TourContext);
  if (!c) throw new Error('useTour outside <TourProvider>');
  return c;
}

const storeKey = (userId: string) => `mg-tour-seen:${userId}`;
function readSeen(userId: string | undefined) {
  if (!userId) return true;
  try {
    return localStorage.getItem(storeKey(userId)) === '1';
  } catch {
    return false;
  }
}
function writeSeen(userId: string | undefined) {
  if (!userId) return;
  try {
    localStorage.setItem(storeKey(userId), '1');
  } catch {
    /* private window or blocked storage: the prompt comes back next time */
  }
}

const reducedMotion = () => typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

/** First rendered (non-hidden) element for a tour target: the sidebar and the mobile bar share names. */
function findTarget(name: string): HTMLElement | null {
  for (const el of document.querySelectorAll<HTMLElement>(`[data-tour="${name}"]`)) {
    const r = el.getBoundingClientRect();
    if (r.width > 0 && r.height > 0) return el;
  }
  return null;
}

const onRoute = (route: string) => {
  const p = window.location.pathname.replace(/^\/ui/, '').replace(/\/$/, '') || '/';
  return p === route;
};

export function TourProvider({ children }: { children: ReactNode }) {
  const { user, canAny } = useMe();
  const navigate = useNavigate();
  const [seen, setSeen] = useState(true);
  const [index, setIndex] = useState<number | null>(null);
  const [dir, setDir] = useState<1 | -1>(1);
  const [target, setTarget] = useState<HTMLElement | null>(null);

  useEffect(() => setSeen(readSeen(user?.id)), [user?.id]);

  const steps = useMemo(() => TOUR_STEPS.filter((s) => !s.perms || canAny(...s.perms)), [canAny]);
  const step: TourStep | undefined = index === null ? undefined : steps[index];

  const close = useCallback(() => {
    setIndex(null);
    setTarget(null);
    setSeen(true);
    writeSeen(user?.id);
  }, [user?.id]);

  const go = useCallback(
    (d: 1 | -1) => {
      setDir(d);
      setIndex((i) => {
        if (i === null) return null;
        const n = i + d;
        if (n < 0) return 0;
        if (n >= steps.length) {
          queueMicrotask(close);
          return i;
        }
        return n;
      });
    },
    [steps.length, close],
  );

  // Resolve the current step: open its route, wait for its target, skip it when it never appears.
  useEffect(() => {
    if (!step) return;
    setTarget(null);
    if (!step.target) return;
    if (step.route && !onRoute(step.route)) navigate({ to: step.route });
    let cancelled = false;
    const startedAt = performance.now();
    const look = () => {
      if (cancelled) return;
      const el = (!step.route || onRoute(step.route)) && findTarget(step.target!);
      if (el) {
        el.scrollIntoView({ block: 'nearest', behavior: reducedMotion() ? 'auto' : 'smooth' });
        setTarget(el);
      } else if (performance.now() - startedAt > 3000) go(dir);
      else requestAnimationFrame(look);
    };
    look();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- re-run per step only
  }, [step?.id]);

  const ctx = useMemo<Ctx>(
    () => ({
      start: () => {
        setDir(1);
        setIndex(0);
      },
      dismiss: close,
      active: index !== null,
      seen,
    }),
    [close, index, seen],
  );

  return (
    <TourContext.Provider value={ctx}>
      {children}
      {step && (!step.target || target) && (
        <TourOverlay step={step} target={target} index={index!} total={steps.length} onNext={() => go(1)} onBack={() => go(-1)} onClose={close} />
      )}
    </TourContext.Provider>
  );
}

function useTargetBox(target: HTMLElement | null) {
  const [box, setBox] = useState<Box | null>(null);
  useEffect(() => {
    if (!target) return setBox(null);
    let raf = 0;
    let last = '';
    const tick = () => {
      const r = target.getBoundingClientRect();
      const key = `${r.top}|${r.left}|${r.width}|${r.height}|${window.innerWidth}|${window.innerHeight}`;
      if (key !== last) {
        last = key;
        setBox(spotlightBox({ top: r.top, left: r.left, width: r.width, height: r.height }, window.innerWidth, window.innerHeight));
      }
      raf = requestAnimationFrame(tick);
    };
    tick();
    return () => cancelAnimationFrame(raf);
  }, [target]);
  return box;
}

function TourOverlay({ step, target, index, total, onNext, onBack, onClose }: { step: TourStep; target: HTMLElement | null; index: number; total: number; onNext: () => void; onBack: () => void; onClose: () => void }) {
  const spot = useTargetBox(target);
  const card = useRef<HTMLDivElement>(null);
  const next = useRef<HTMLButtonElement>(null);
  const [size, setSize] = useState({ width: 340, height: 200 });
  const last = index === total - 1;

  useLayoutEffect(() => {
    if (card.current) setSize({ width: card.current.offsetWidth, height: card.current.offsetHeight });
  }, [step.id]);
  useEffect(() => next.current?.focus({ preventScroll: true }), [step.id]);

  // Keys stay inside the tour: arrows move, Escape leaves, Tab cycles the card's buttons,
  // and the app's own shortcuts (g k, ⌘K) are held back until the tour ends.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowRight') onNext();
      else if (e.key === 'ArrowLeft' && index > 0) onBack();
      else if (e.key === 'Escape') onClose();
      else if (e.key === 'Tab' && card.current) {
        const f = [...card.current.querySelectorAll<HTMLElement>('button:not([disabled]), a[href]')];
        const at = f.indexOf(document.activeElement as HTMLElement);
        const to = f[(at + (e.shiftKey ? -1 : 1) + f.length) % f.length];
        to?.focus();
      } else {
        e.stopPropagation();
        return;
      }
      e.preventDefault();
      e.stopPropagation();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [index, onNext, onBack, onClose]);

  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const pos = spot ? cardPosition(spot, size, vw, vh, step.placement) : { top: (vh - size.height) / 2, left: (vw - size.width) / 2 };

  return (
    <div className="fixed inset-0 z-[60]" data-testid="tour">
      {/* blocks the page; the spotlight's shadow does the dimming */}
      <div className={cn('absolute inset-0', !spot && 'bg-black/55')} aria-hidden onClick={(e) => e.stopPropagation()} />
      {spot && (
        <div
          aria-hidden
          className="pointer-events-none absolute top-0 left-0 rounded-lg motion-safe:transition-transform motion-safe:duration-300"
          style={{
            width: spot.width,
            height: spot.height,
            transform: `translate(${spot.left}px, ${spot.top}px)`,
            boxShadow: '0 0 0 1.5px var(--brand), 0 0 0 9999px rgb(9 9 11 / 0.55)',
          }}
        />
      )}
      <div
        ref={card}
        key={step.id}
        role="dialog"
        aria-modal="true"
        aria-labelledby="tour-title"
        aria-describedby="tour-body"
        className="bg-popover text-popover-foreground motion-safe:animate-in motion-safe:fade-in-0 motion-safe:slide-in-from-bottom-1 absolute w-85 max-w-[calc(100vw-32px)] rounded-xl border p-5 shadow-[0_8px_24px_rgb(0_0_0/0.12)] motion-safe:duration-200"
        style={{ top: pos.top, left: pos.left }}
      >
        <div className="flex items-center justify-between gap-4">
          <ol className="flex items-center gap-1.5" aria-label={`Step ${index + 1} of ${total}`}>
            {Array.from({ length: total }, (_, i) => (
              <li
                key={i}
                className={cn(
                  'size-1.5 rounded-full',
                  i < index && 'bg-brand',
                  i === index && 'ring-brand ring-[1.5px] ring-offset-0',
                  i > index && 'bg-muted-foreground/30',
                )}
              />
            ))}
          </ol>
          <span className="text-muted-foreground tabular font-mono text-xs">
            {index + 1} of {total}
          </span>
        </div>
        <h2 id="tour-title" className="mt-4 text-base leading-6 font-medium">
          {step.title}
        </h2>
        <p id="tour-body" className="text-secondary-foreground mt-1.5 text-sm leading-5">
          {step.body}
        </p>
        <div className="mt-5 flex items-center gap-2">
          {!last && (
            <Button variant="ghost" size="sm" className="text-secondary-foreground -ml-2" onClick={onClose}>
              Skip tour
            </Button>
          )}
          <div className="ml-auto flex gap-2">
            {index > 0 && (
              <Button variant="outline" size="sm" onClick={onBack}>
                Back
              </Button>
            )}
            <Button ref={next} size="sm" onClick={onNext}>
              {index === 0 ? 'Start' : last ? 'Finish' : 'Next'}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

/** Quiet offer in the sidebar until the user has taken or dismissed the tour. */
export function TourPrompt() {
  const { start, dismiss, active, seen } = useTour();
  if (seen || active) return null;
  return (
    <div className="bg-card relative mx-3 mb-3 rounded-lg border p-3 pr-8 text-sm shadow-[var(--shadow-sm)]" data-testid="tour-prompt">
      <button type="button" aria-label="Dismiss tour" onClick={dismiss} className="text-muted-foreground hover:text-foreground absolute top-2 right-2 rounded-sm p-1 transition-colors">
        <X className="size-3.5" />
      </button>
      <div className="flex items-center gap-2 font-medium">
        <RouteIcon className="text-muted-foreground size-4" strokeWidth={1.5} /> New here
      </div>
      <p className="text-secondary-foreground mt-1">A two-minute walk through keys, guardrails and the message log</p>
      <Button size="sm" variant="outline" className="mt-3 w-full" onClick={start}>
        Take the tour
      </Button>
    </div>
  );
}
