// Authored by Tomás Neto (TN 2026)
import { describe, expect, it } from 'vitest';
import { cardPosition, EDGE, GAP, PAD, spotlightBox } from './position';
import { TOUR_STEPS } from './steps';

const VW = 1440;
const VH = 900;
const CARD = { width: 340, height: 200 };

describe('tour geometry', () => {
  it('pads the spotlight and clamps it to the viewport', () => {
    expect(spotlightBox({ top: 100, left: 300, width: 200, height: 40 }, VW, VH)).toEqual({ top: 100 - PAD, left: 300 - PAD, width: 200 + 2 * PAD, height: 40 + 2 * PAD });
    const tall = spotlightBox({ top: 120, left: 240, width: 1200, height: 3000 }, VW, VH);
    expect(tall.top + tall.height).toBeLessThanOrEqual(VH);
    expect(tall.left + tall.width).toBeLessThanOrEqual(VW);
  });

  it('places the card on the preferred side when it fits', () => {
    const spot = { top: 100, left: 300, width: 200, height: 40 };
    expect(cardPosition(spot, CARD, VW, VH, 'bottom')).toMatchObject({ placement: 'bottom', top: 140 + GAP, left: 300 });
    expect(cardPosition(spot, CARD, VW, VH, 'right')).toMatchObject({ placement: 'right', left: 500 + GAP });
  });

  it('flips when the preferred side has no room and keeps the card on screen', () => {
    const nearBottom = { top: 800, left: 1300, width: 120, height: 40 };
    const p = cardPosition(nearBottom, CARD, VW, VH, 'bottom');
    expect(p.placement).toBe('top');
    expect(p.left + CARD.width).toBeLessThanOrEqual(VW - EDGE);
  });

  it('falls back to the corner when the target fills the screen', () => {
    const full = spotlightBox({ top: 0, left: 0, width: VW, height: VH }, VW, VH);
    expect(cardPosition(full, CARD, VW, VH)).toMatchObject({ placement: 'corner' });
  });

  it('has unique step ids and plain copy', () => {
    expect(new Set(TOUR_STEPS.map((s) => s.id)).size).toBe(TOUR_STEPS.length);
    for (const s of TOUR_STEPS) {
      expect(s.title).not.toMatch(/[!.]$/);
      expect(s.body).not.toMatch(/!/);
    }
  });
});
