/**
 * RFC 4180 CSV with spreadsheet formula-injection protection (OWASP "CSV injection"):
 * cells starting with = + - @ TAB CR are prefixed with a single quote so Excel/LibreOffice
 * treat them as text. Message subjects and recipients come from external clients.
 */
export type CsvDelimiter = ',' | ';';

const FORMULA_START = /^[=+\-@\t\r]/;

export function csvCell(value: unknown, delimiter: CsvDelimiter = ','): string {
  if (value === null || value === undefined) return '';
  let s = value instanceof Date ? value.toISOString() : Array.isArray(value) ? value.join(' ') : typeof value === 'object' ? JSON.stringify(value) : String(value);
  if (FORMULA_START.test(s)) s = `'${s}`;
  if (s.includes('"') || s.includes(delimiter) || s.includes('\n') || s.includes('\r')) s = `"${s.replace(/"/g, '""')}"`;
  return s;
}

export function csvRow(values: unknown[], delimiter: CsvDelimiter = ','): string {
  return values.map((v) => csvCell(v, delimiter)).join(delimiter) + '\r\n';
}

/** UTF-8 BOM so Excel detects the encoding (accents in names/subjects). */
export const CSV_BOM = '﻿';

/** Safe file name part: letters, digits, dot, dash, underscore. */
export function fileSafe(s: string): string {
  return s.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 60) || 'export';
}
