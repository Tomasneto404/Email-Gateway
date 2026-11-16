import pino, { DestinationStream, Logger } from 'pino';

export const ROOT_LOGGER = Symbol('ROOT_LOGGER');

/**
 * Paths that must never reach application logs. Message bodies are never passed to the
 * logger in the first place (they live only in the audit table); this is defence in depth.
 */
export const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-csrf-token"]',
  'res.headers["set-cookie"]',
  '*.password',
  '*.secret',
  '*.apiKey',
  '*.token',
  '*.text',
  '*.html',
  '*.textBody',
  '*.htmlBody',
];

export function createRootLogger(opts: { level: string; service: string; destination?: DestinationStream }): Logger {
  return pino(
    {
      level: opts.level,
      base: { service: 'mail-gateway', component: opts.service },
      timestamp: pino.stdTimeFunctions.isoTime,
      redact: { paths: REDACT_PATHS, censor: '[redacted]' },
      formatters: { level: (label) => ({ level: label }) },
    },
    opts.destination,
  );
}
