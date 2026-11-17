// Authored by Tomás Neto (TN 2026)
import { ExternalLink } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';

/** ↑ ↑ ↓ ↓ ← → ← → B A */
const SEQUENCE = ['arrowup', 'arrowup', 'arrowdown', 'arrowdown', 'arrowleft', 'arrowright', 'arrowleft', 'arrowright', 'b', 'a'];
const GITHUB = 'https://github.com/Tomasneto404';

/** The flag of Portugal, drawn inline (strict CSP: no remote images). */
export function PortugalFlag({ className }: { className?: string }) {
  const castles = [
    [240, 158],
    [214, 166],
    [266, 166],
    [208, 198],
    [272, 198],
    [214, 232],
    [266, 232],
  ];
  const escutcheons = [
    [240, 184],
    [222, 202],
    [240, 202],
    [258, 202],
    [240, 220],
  ];
  return (
    <svg viewBox="0 0 600 400" className={className} role="img" aria-label="Flag of Portugal">
      <rect width="600" height="400" fill="#da291c" />
      <rect width="240" height="400" fill="#046a38" />
      {/* armillary sphere */}
      <g fill="none" stroke="#ffe000" strokeWidth="7">
        <circle cx="240" cy="200" r="78" />
        <ellipse cx="240" cy="200" rx="78" ry="22" />
        <ellipse cx="240" cy="200" rx="78" ry="22" transform="rotate(28 240 200)" />
        <ellipse cx="240" cy="200" rx="78" ry="22" transform="rotate(-28 240 200)" />
        <ellipse cx="240" cy="200" rx="26" ry="78" />
      </g>
      {/* shield: red border with seven castles, white field with five blue escutcheons */}
      <path d="M196 148h88v58c0 30-20 48-44 54-24-6-44-24-44-54z" fill="#da291c" stroke="#fff" strokeWidth="2" />
      <path d="M210 162h60v44c0 20-13 32-30 37-17-5-30-17-30-37z" fill="#fff" />
      {castles.map(([x, y]) => (
        <path key={`${x}-${y}`} d={`M${x - 5} ${y + 5}v-8h2v2h2v-2h2v2h2v-2h2v8z`} fill="#ffe000" />
      ))}
      {escutcheons.map(([x, y]) => (
        <g key={`${x}-${y}`}>
          <path d={`M${x - 6} ${y - 7}h12v8c0 4-3 6-6 7-3-1-6-3-6-7z`} fill="#002d72" />
          <circle cx={x} cy={y - 1} r="1.4" fill="#fff" />
        </g>
      ))}
    </svg>
  );
}

/** Listens for the Konami code anywhere in the app (outside text fields) and shows the credits. */
export function KonamiEasterEgg() {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    let pos = 0;
    const onKey = (e: KeyboardEvent) => {
      const t = e.target;
      if (t instanceof HTMLElement && (t.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName))) return;
      const key = e.key.toLowerCase();
      pos = key === SEQUENCE[pos] ? pos + 1 : key === SEQUENCE[0] ? 1 : 0;
      if (pos === SEQUENCE.length) {
        pos = 0;
        setOpen(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="sm:max-w-sm" data-testid="konami">
        <PortugalFlag className="w-full rounded-lg border" />
        <DialogHeader className="items-center text-center sm:text-center">
          <DialogTitle>Developed by Tomás Neto</DialogTitle>
          <DialogDescription>
            <a href={GITHUB} target="_blank" rel="noreferrer" className="text-brand inline-flex items-center gap-1.5 hover:underline">
              github.com/Tomasneto404 <ExternalLink className="size-3.5" />
            </a>
          </DialogDescription>
        </DialogHeader>
      </DialogContent>
    </Dialog>
  );
}
