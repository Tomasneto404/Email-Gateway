// Authored by Tomás Neto (TN 2026)
import { GatewayError } from '../common/errors';

/** {{ name }} — letters, digits, "_" and "."; no logic, no raw HTML. */
const VAR_RE = /\{\{\s*([A-Za-z_][A-Za-z0-9_.]{0,63})\s*\}\}/g;
const MAX_VARIABLES = 50;
const MAX_VALUE = 5000;

export interface TemplateSource {
  name: string;
  subject: string;
  text: string | null;
  html: string | null;
}

export function templateVariables(t: Pick<TemplateSource, 'subject' | 'text' | 'html'>): string[] {
  const out = new Set<string>();
  for (const part of [t.subject, t.text ?? '', t.html ?? '']) for (const m of part.matchAll(VAR_RE)) out.add(m[1]);
  return [...out].sort();
}

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/**
 * Renders a template. Every variable must be provided, unknown ones are refused (they usually mean
 * a typo by the caller), values are escaped in HTML and may not contain line breaks in the subject.
 */
export function renderTemplate(t: TemplateSource, input: unknown): { subject: string; text?: string; html?: string } {
  if (input !== undefined && (typeof input !== 'object' || input === null || Array.isArray(input))) {
    throw new GatewayError('VALIDATION_FAILED', 'variables must be a JSON object of name → value.');
  }
  const vars = (input ?? {}) as Record<string, unknown>;
  const names = Object.keys(vars);
  if (names.length > MAX_VARIABLES) throw new GatewayError('VALIDATION_FAILED', `At most ${MAX_VARIABLES} variables.`);
  const values: Record<string, string> = {};
  for (const n of names) {
    const v = vars[n];
    if (typeof v !== 'string' && typeof v !== 'number' && typeof v !== 'boolean') {
      throw new GatewayError('VALIDATION_FAILED', `Variable "${n}" must be a string, number or boolean.`);
    }
    const s = String(v);
    if (s.length > MAX_VALUE) throw new GatewayError('VALIDATION_FAILED', `Variable "${n}" is longer than ${MAX_VALUE} characters.`);
    values[n] = s;
  }
  const expected = templateVariables(t);
  const missing = expected.filter((n) => !(n in values));
  const unknown = names.filter((n) => !expected.includes(n));
  if (missing.length || unknown.length) {
    throw new GatewayError(
      'VALIDATION_FAILED',
      [
        missing.length ? `Missing template variables: ${missing.join(', ')}.` : '',
        unknown.length ? `Unknown template variables: ${unknown.join(', ')}.` : '',
        `Template "${t.name}" expects: ${expected.join(', ') || '(none)'}.`,
      ]
        .filter(Boolean)
        .join(' '),
      { missing, unknown, expected },
    );
  }
  const subjectVars = new Set([...t.subject.matchAll(VAR_RE)].map((m) => m[1]));
  for (const n of subjectVars) {
    if (/[\r\n]/.test(values[n])) throw new GatewayError('VALIDATION_FAILED', `Variable "${n}" is used in the subject and must not contain line breaks.`);
  }
  const plain = (s: string) => s.replace(VAR_RE, (_, n: string) => values[n]);
  const subject = plain(t.subject).trim();
  if (!subject) throw new GatewayError('VALIDATION_FAILED', 'The rendered subject is empty.');
  return {
    subject: subject.slice(0, 998),
    ...(t.text ? { text: plain(t.text) } : {}),
    ...(t.html ? { html: t.html.replace(VAR_RE, (_, n: string) => escapeHtml(values[n])) } : {}),
  };
}
