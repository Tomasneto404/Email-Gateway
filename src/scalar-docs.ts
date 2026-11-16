import { Router } from 'express';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

/**
 * Scalar API reference at /docs, fully self-hosted: the standalone bundle is copied into
 * dist/docs-assets at build time (no CDN), and the init code is a separate file so the CSP
 * needs no inline scripts. Telemetry, Scalar fonts, the AI agent and the request proxy are off.
 */
export const DOCS_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "worker-src 'self' blob:",
  "frame-ancestors 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

export const SCALAR_CONFIG = {
  url: '/openapi.json',
  telemetry: false,
  withDefaultFonts: false,
  agent: { disabled: true },
  showDeveloperTools: 'never',
  persistAuth: false,
  hideModels: false,
  documentDownloadType: 'both',
  defaultOpenFirstTag: true,
  authentication: { preferredSecurityScheme: 'apiKey' },
  metaData: { title: 'mail-gateway API' },
};

const HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>mail-gateway API</title>
  </head>
  <body>
    <div id="app"></div>
    <script src="/docs/scalar.js"></script>
    <script src="/docs/init.js"></script>
  </body>
</html>`;

const INIT = `Scalar.createApiReference('#app', ${JSON.stringify(SCALAR_CONFIG)});\n`;

/** dist/docs-assets/scalar.js in builds; falls back to node_modules in dev/tests. */
export function resolveScalarBundle(): string | null {
  const candidates = [
    join(__dirname, 'docs-assets', 'scalar.js'),
    resolve(process.cwd(), 'node_modules/@scalar/api-reference/dist/browser/standalone.js'),
  ];
  return candidates.find((p) => existsSync(p)) ?? null;
}

export function scalarRouter(): Router | null {
  const bundle = resolveScalarBundle();
  if (!bundle) return null;
  const r = Router();
  r.use((_req, res, next) => {
    res.setHeader('Content-Security-Policy', DOCS_CSP);
    res.setHeader('X-Frame-Options', 'DENY');
    next();
  });
  r.get('/', (_req, res) => {
    res.setHeader('Cache-Control', 'no-cache');
    res.type('html').send(HTML);
  });
  r.get('/init.js', (_req, res) => {
    res.setHeader('Cache-Control', 'no-cache');
    res.type('application/javascript').send(INIT);
  });
  r.get('/scalar.js', (_req, res) => {
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.sendFile(bundle);
  });
  return r;
}
