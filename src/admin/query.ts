// Authored by Tomás Neto (TN 2026)
import { GatewayError } from '../common/errors';

export function qInt(v: unknown, def?: number): number | undefined {
  if (v === undefined || v === '') return def;
  const n = Number(v);
  if (!Number.isInteger(n)) throw new GatewayError('VALIDATION_FAILED', `Expected an integer, got "${String(v)}".`);
  return n;
}
export function qDate(v: unknown): Date | undefined {
  if (v === undefined || v === '') return undefined;
  const d = new Date(String(v));
  if (Number.isNaN(d.getTime())) throw new GatewayError('VALIDATION_FAILED', `Invalid date "${String(v)}".`);
  return d;
}
export function qEnum<T extends string>(v: unknown, allowed: readonly T[]): T | undefined {
  if (v === undefined || v === '') return undefined;
  if (!allowed.includes(v as T)) throw new GatewayError('VALIDATION_FAILED', `Expected one of ${allowed.join(', ')}.`);
  return v as T;
}
export function qList<T extends string>(v: unknown, allowed: readonly T[]): T[] | undefined {
  if (v === undefined || v === '') return undefined;
  const parts = (Array.isArray(v) ? v : String(v).split(',')).map(String).filter(Boolean);
  for (const p of parts) if (!allowed.includes(p as T)) throw new GatewayError('VALIDATION_FAILED', `Unknown value "${p}". Expected ${allowed.join(', ')}.`);
  return parts as T[];
}
export function qBool(v: unknown): boolean | undefined {
  if (v === undefined || v === '') return undefined;
  return v === 'true' || v === '1';
}
export function qStr(v: unknown, max = 200): string | undefined {
  if (v === undefined || v === '') return undefined;
  return String(v).slice(0, max);
}
