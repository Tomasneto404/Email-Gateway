// Authored by Tomás Neto (TN 2026)
import express, { NextFunction, Request, Response, Router } from 'express';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { AppConfig } from './config/config';

/** Strict CSP for the admin SPA: no inline/remote scripts; framing only for our own preview endpoint. */
export const UI_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  // Radix/sonner set inline style attributes/elements at runtime; no inline *scripts* are allowed.
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "frame-src 'self'",
  "frame-ancestors 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
].join('; ');

export function resolveUiDir(cfg: AppConfig): string {
  return cfg.UI_DIST_PATH ? resolve(cfg.UI_DIST_PATH) : resolve(__dirname, '..', 'ui', 'dist');
}

/** Serves ui/dist at /ui (same origin as the API, so no CORS) with an SPA fallback. */
export function uiRouter(cfg: AppConfig): Router | null {
  const dir = resolveUiDir(cfg);
  const index = join(dir, 'index.html');
  if (!cfg.UI_ENABLED || !existsSync(index)) return null;
  const r = Router();
  r.use((_req: Request, res: Response, next: NextFunction) => {
    res.setHeader('Content-Security-Policy', UI_CSP);
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    next();
  });
  r.use(
    express.static(dir, {
      index: false,
      setHeaders: (res, path) => {
        res.setHeader('Cache-Control', path.includes(`${join('assets', '')}`) ? 'public, max-age=31536000, immutable' : 'no-cache');
      },
    }),
  );
  r.get(/.*/, (_req, res) => {
    res.setHeader('Cache-Control', 'no-cache');
    res.sendFile(index);
  });
  return r;
}
