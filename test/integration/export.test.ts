import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LoggedIn, login } from '../helpers/admin-login';
import { Stack, createKey, resetState, startStack, uname } from '../helpers/stack';

/** Minimal RFC 4180 parser for assertions. */
function parseCsv(text: string, d = ','): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let q = false;
  const s = text.replace(/^﻿/, '');
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (c === '"' && s[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (c === '"') q = false;
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === d) {
      row.push(cell);
      cell = '';
    } else if (c === '\r' && s[i + 1] === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
      i++;
    } else cell += c;
  }
  return rows;
}

let s: Stack;
let admin: LoggedIn;
let keyId: string;
let keyName: string;
let secret: string;

beforeAll(async () => {
  s = await startStack({}, { worker: false });
  await resetState(s);
  admin = await login(s, 'admin');
  const k = await createKey(s, { name: uname('exp') });
  ({ secret } = k);
  keyId = k.key.id;
  keyName = k.key.name;
  const auth = { Authorization: `Bearer ${secret}` };
  await s.http.post('/v1/send').set(auth).send({ to: 'a@example.com', subject: '=HYPERLINK("http://evil","x")', text: 'BODY-NEVER-EXPORTED' });
  await s.http.post('/v1/send').set(auth).send({ to: ['b@example.com', 'c@example.com'], subject: 'hello, "world"', text: 'x' });
  await s.http.post('/v1/send').set(auth).send({ to: 'x@evil.io', subject: 'rejected one', text: 'x' });
});
afterAll(async () => s?.close());

describe('messages CSV export', () => {
  it('exports one key: headers, rows, escaping, formula neutralised, no bodies', async () => {
    const r = await admin.agent.get('/admin/messages/export.csv').query({ keyId }).buffer(true).parse((res, cb) => {
      let d = '';
      res.on('data', (c: Buffer) => (d += c.toString('utf8')));
      res.on('end', () => cb(null, d));
    });
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toMatch(/text\/csv/);
    expect(r.headers['content-disposition']).toMatch(new RegExp(`attachment; filename="messages-${keyName}-\\d{4}-\\d{2}-\\d{2}\\.csv"`));
    expect(r.headers['x-export-rows']).toBe('3');
    const text = r.body as string;
    expect(text.startsWith('﻿')).toBe(true);
    expect(text).not.toContain('BODY-NEVER-EXPORTED');
    const rows = parseCsv(text);
    expect(rows[0].slice(0, 5)).toEqual(['id', 'created_at', 'sent_at', 'status', 'key_name']);
    expect(rows).toHaveLength(4);
    const col = (n: string) => rows[0].indexOf(n);
    const subjects = rows.slice(1).map((x) => x[col('subject')]);
    expect(subjects).toContain(`'=HYPERLINK("http://evil","x")`);
    expect(subjects).toContain('hello, "world"');
    const rej = rows.find((x) => x[col('subject')] === 'rejected one')!;
    expect(rej[col('status')]).toBe('rejected');
    expect(rej[col('reject_code')]).toBe('RECIPIENT_NOT_ALLOWED');
    expect(rows.find((x) => x[col('subject')] === 'hello, "world"')![col('to')]).toBe('b@example.com c@example.com');
  });

  it('honours filters and the semicolon delimiter', async () => {
    const r = await admin.agent.get('/admin/messages/export.csv').query({ keyId, status: 'rejected', delimiter: 'semicolon' });
    const rows = parseCsv(r.text, ';');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toContain('reject_code');
  });

  it('validates ids and records the export in the activity log', async () => {
    expect((await admin.agent.get('/admin/messages/export.csv').query({ keyId: 'nope' })).body.error.code).toBe('VALIDATION_FAILED');
    const a = await s.prisma.adminAudit.findFirst({ where: { action: 'export.messages', targetId: keyId }, orderBy: { at: 'desc' } });
    expect(a?.details).toMatchObject({ rows: expect.any(Number), truncated: false, filters: { keyId } });
  });
});

describe('activity log CSV export', () => {
  it('per API key: only actions on that key', async () => {
    await admin.agent.post(`/admin/keys/${keyId}/rotate`).set(admin.h).send({});
    const r = await admin.agent.get('/admin/audit/export.csv').query({ keyId });
    const rows = parseCsv(r.text);
    const col = (n: string) => rows[0].indexOf(n);
    expect(r.headers['content-disposition']).toContain(`activity-key-${keyName}`);
    const body = rows.slice(1);
    expect(body.length).toBeGreaterThanOrEqual(2);
    expect(body.every((x) => x[col('target_id')] === keyId)).toBe(true);
    expect(body.map((x) => x[col('action')])).toEqual(expect.arrayContaining(['key.create', 'key.rotate']));
  });

  it('per user: only that user’s actions', async () => {
    const other = await login(s, 'admin');
    await other.agent.post('/admin/gateway/pause').set(other.h).send({ reason: 'csv' });
    await other.agent.post('/admin/gateway/resume').set(other.h).send({});
    const r = await admin.agent.get('/admin/audit/export.csv').query({ actorId: other.userId });
    const rows = parseCsv(r.text);
    const col = (n: string) => rows[0].indexOf(n);
    expect(rows.slice(1).every((x) => x[col('actor_id')] === other.userId)).toBe(true);
    expect(rows.slice(1).map((x) => x[col('action')])).toEqual(expect.arrayContaining(['gateway.pause', 'gateway.resume', 'auth.login']));
    // same filter works on the list endpoint
    const list = await admin.agent.get('/admin/audit').query({ actorId: other.userId });
    expect(list.body.items.every((a: { actorId: string }) => a.actorId === other.userId)).toBe(true);
  });

  it('general export includes details as JSON and is itself audited', async () => {
    const r = await admin.agent.get('/admin/audit/export.csv');
    const rows = parseCsv(r.text);
    expect(rows[0]).toEqual(['id', 'at', 'actor_type', 'actor', 'actor_id', 'action', 'outcome', 'target_type', 'target_id', 'ip', 'details']);
    expect(rows.length).toBeGreaterThan(3);
    await new Promise((res) => setTimeout(res, 50));
    expect(await s.prisma.adminAudit.count({ where: { action: 'export.activity', actorId: admin.userId } })).toBeGreaterThan(0);
  });
});

describe('permissions and limits', () => {
  it('needs messages:read / audit:read', async () => {
    const approver = await login(s, ['Approver']); // has messages:read, not audit:read
    expect((await approver.agent.get('/admin/messages/export.csv')).status).toBe(200);
    expect((await approver.agent.get('/admin/audit/export.csv')).status).toBe(403);
  });

  it('truncates at EXPORT_MAX_ROWS and says so', async () => {
    const small = await startStack({ EXPORT_MAX_ROWS: '2' }, { worker: false });
    try {
      const a = await login(small, 'admin');
      const r = await a.agent.get('/admin/messages/export.csv');
      expect(r.headers['x-export-truncated']).toBe('true');
      expect(parseCsv(r.text)).toHaveLength(3); // header + 2
    } finally {
      await small.close();
    }
  });
});
