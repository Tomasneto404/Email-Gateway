// Authored by Tomás Neto (TN 2026)
import { createHmac } from 'node:crypto';

export interface AlertPayload {
  id: string;
  type: string;
  severity: string;
  title: string;
  detail: Record<string, unknown>;
  at: string;
  gateway: string | null;
}

/** `X-Mail-Gateway-Signature: sha256=<hex>` over "<timestamp>.<body>" (receivers recompute it with the channel secret). */
export function signWebhook(secret: string, timestamp: string, body: string): string {
  return `sha256=${createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')}`;
}

function detailLines(d: Record<string, unknown>): string[] {
  return Object.entries(d)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .slice(0, 12)
    .map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : String(v)}`);
}

export function slackBody(p: AlertPayload): string {
  const lines = [`*[${p.severity}] ${p.title}*`, ...detailLines(p.detail).map((l) => `• ${l}`)];
  if (p.gateway) lines.push(`<${p.gateway}/ui|Open mail-gateway>`);
  return JSON.stringify({ text: lines.join('\n') });
}

export function emailContent(p: AlertPayload): { subject: string; text: string; html: string } {
  const lines = detailLines(p.detail);
  const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
  const link = p.gateway ? `${p.gateway}/ui` : null;
  return {
    subject: `[mail-gateway ${p.severity}] ${p.title}`.replace(/[\r\n]+/g, ' ').slice(0, 300),
    text: [p.title, '', ...lines, '', `Alert ${p.type} at ${p.at}`, ...(link ? [link] : [])].join('\n'),
    html: `<p><strong>${esc(p.title)}</strong></p><ul>${lines.map((l) => `<li>${esc(l)}</li>`).join('')}</ul><p style="color:#737373">Alert ${esc(p.type)} at ${esc(p.at)}${link ? ` · <a href="${esc(link)}">Open mail-gateway</a>` : ''}</p>`,
  };
}

export async function postJson(url: string, body: string, headers: Record<string, string>, timeoutMs = 10_000): Promise<void> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': 'mail-gateway-alerts', ...headers },
    body,
    redirect: 'error',
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status}${text ? `: ${text.slice(0, 200)}` : ''}`);
  }
}
