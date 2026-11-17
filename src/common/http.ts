import type { Request } from 'express';

/** Client IP honouring the express `trust proxy` setting (HAProxy X-Forwarded-For). */
export function clientIp(req: Request): string {
  return req.ip ?? req.socket.remoteAddress ?? 'unknown';
}

export function bearerToken(req: Request): string | undefined {
  const h = req.headers.authorization;
  if (!h) return undefined;
  const m = /^Bearer\s+(\S+)\s*$/i.exec(h);
  return m?.[1];
}

/** Request path for logs, with credential-bearing segments (invite tokens) masked and no query string. */
export function safeLogPath(url: string): string {
  return url.split('?')[0].replace(/^(\/admin\/auth\/invite\/)[^/]+/, '$1[redacted]');
}
