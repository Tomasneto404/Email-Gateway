// Authored by Tomás Neto (TN 2026)
/** Pure geometry for the guided tour: where the spotlight and the step card go. */

export type Box = { top: number; left: number; width: number; height: number };
export type Placement = 'bottom' | 'top' | 'right' | 'left';

export const GAP = 12;
export const EDGE = 16;
export const PAD = 6;

/** The visible part of the target, padded, clamped to the viewport (tall tables, long lists). */
export function spotlightBox(r: Box, vw: number, vh: number): Box {
  const top = Math.max(EDGE / 2, r.top - PAD);
  const left = Math.max(EDGE / 2, r.left - PAD);
  const bottom = Math.min(vh - EDGE / 2, r.top + r.height + PAD);
  const right = Math.min(vw - EDGE / 2, r.left + r.width + PAD);
  return { top, left, width: Math.max(0, right - left), height: Math.max(0, bottom - top) };
}

const clamp = (v: number, min: number, max: number) => Math.min(Math.max(v, min), Math.max(min, max));

/**
 * Card position next to the spotlight: the preferred side first, then the others, the first one
 * that fits wins. When nothing fits (the target fills the screen) the card sits in the bottom-right
 * corner over the target.
 */
export function cardPosition(spot: Box, card: { width: number; height: number }, vw: number, vh: number, prefer: Placement = 'bottom'): { top: number; left: number; placement: Placement | 'corner' } {
  const order: Placement[] = [prefer, ...(['bottom', 'right', 'top', 'left'] as Placement[]).filter((p) => p !== prefer)];
  for (const p of order) {
    if (p === 'bottom' && spot.top + spot.height + GAP + card.height <= vh - EDGE)
      return { placement: p, top: spot.top + spot.height + GAP, left: clamp(spot.left, EDGE, vw - card.width - EDGE) };
    if (p === 'top' && spot.top - GAP - card.height >= EDGE)
      return { placement: p, top: spot.top - GAP - card.height, left: clamp(spot.left, EDGE, vw - card.width - EDGE) };
    if (p === 'right' && spot.left + spot.width + GAP + card.width <= vw - EDGE)
      return { placement: p, left: spot.left + spot.width + GAP, top: clamp(spot.top, EDGE, vh - card.height - EDGE) };
    if (p === 'left' && spot.left - GAP - card.width >= EDGE)
      return { placement: p, left: spot.left - GAP - card.width, top: clamp(spot.top, EDGE, vh - card.height - EDGE) };
  }
  return { placement: 'corner', top: vh - card.height - EDGE * 2, left: vw - card.width - EDGE * 2 };
}
