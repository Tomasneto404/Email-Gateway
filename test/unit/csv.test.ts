import { describe, expect, it } from 'vitest';
import { csvCell, csvRow, fileSafe } from '../../src/common/csv';

describe('CSV', () => {
  it('quotes delimiters, quotes and newlines (RFC 4180)', () => {
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell('l1\nl2')).toBe('"l1\nl2"');
    expect(csvCell('a;b', ';')).toBe('"a;b"');
    expect(csvCell('a,b', ';')).toBe('a,b');
  });
  it('neutralises spreadsheet formulas (CSV injection)', () => {
    for (const evil of ['=HYPERLINK("http://x","click")', '+1+1', '-2+3', '@SUM(A1)', '\tx', '\rx']) {
      expect(csvCell(evil).replace(/^"/, '').startsWith("'")).toBe(true);
    }
    expect(csvCell('=1,2')).toBe(`"'=1,2"`);
    expect(csvCell('normal')).toBe('normal');
  });
  it('formats dates, arrays, objects, nulls', () => {
    expect(csvCell(new Date('2026-11-17T10:00:00Z'))).toBe('2026-11-17T10:00:00.000Z');
    expect(csvCell(['a@x.io', 'b@x.io'])).toBe('a@x.io b@x.io');
    expect(csvCell({ a: 1 })).toBe('"{""a"":1}"');
    expect(csvCell(null)).toBe('');
    expect(csvRow([1, null, 'x'])).toBe('1,,x\r\n');
  });
  it('safe file names', () => {
    expect(fileSafe('my key/../x')).toBe('my_key_.._x');
    expect(fileSafe('user-a@b.c')).toBe('user-a_b.c');
  });
});
