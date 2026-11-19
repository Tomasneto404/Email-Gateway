// Authored by Tomás Neto (TN 2026)
import { createHmac, randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { canonicalJson, AuditChainService } from '../../src/admin/audit-chain.service';
import { signWebhook, slackBody, emailContent } from '../../src/alerts/deliver';
import { BodyCrypto } from '../../src/common/body-crypto';
import { isGatewayError } from '../../src/common/errors';
import { ipAllowed, isIpRule } from '../../src/common/ip';
import { buildConfig } from '../../src/config/config';
import { evaluateDmarc, evaluateSpf } from '../../src/keys/domain-check.service';
import { clamScan } from '../../src/policy/clamav.service';
import { attachmentProblem, enforceContent, extractLinks, findSecret, hostAllowed, type ContentPolicy } from '../../src/policy/content-guard';
import type { NormalizedMessage } from '../../src/policy/policy-engine';
import { domainCounts, parseDomainLimits, parseWarmupSchedule, warmupState } from '../../src/policy/sending-limits';
import { renderTemplate, templateVariables } from '../../src/templates/template-engine';

const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    if (isGatewayError(e)) return e.code;
    throw e;
  }
  return 'OK';
};

const msg = (p: Partial<NormalizedMessage> = {}): NormalizedMessage => ({ to: ['a@example.com'], cc: [], bcc: [], subject: 'Hi', text: 'Hello', attachments: [], ...p });
const policy = (p: Partial<ContentPolicy> = {}): ContentPolicy => ({ name: 'k', allowedLinkDomains: [], maxLinks: null, blockSecrets: true, allowedAttachmentTypes: [], ...p });

describe('content guard', () => {
  it('extracts links from html attributes and bare text', () => {
    const links = extractLinks({ html: '<a href="https://app.example.com/x?a=1&amp;b=2">x</a><img src=http://cdn.example.net/p.png>', text: 'see https://docs.example.org/page.' });
    expect(links).toEqual(expect.arrayContaining(['https://app.example.com/x?a=1&b=2', 'http://cdn.example.net/p.png', 'https://docs.example.org/page']));
  });

  it('allows a domain and its subdomains only', () => {
    expect(hostAllowed('app.example.com', ['example.com'])).toBe(true);
    expect(hostAllowed('example.com', ['example.com'])).toBe(true);
    expect(hostAllowed('evil-example.com', ['example.com'])).toBe(false);
    expect(hostAllowed('example.com.evil.net', ['example.com'])).toBe(false);
  });

  it('enforces link domains and link counts', () => {
    const m = msg({ html: '<a href="https://example.com/a">a</a> <a href="https://phish.net/login">b</a>' });
    expect(code(() => enforceContent(policy({ allowedLinkDomains: ['example.com'] }), m))).toBe('LINK_NOT_ALLOWED');
    expect(code(() => enforceContent(policy({ maxLinks: 1 }), m))).toBe('TOO_MANY_LINKS');
    expect(code(() => enforceContent(policy({ allowedLinkDomains: ['example.com', 'phish.net'], maxLinks: 2 }), m))).toBe('OK');
  });

  it('finds credentials and payment data, not ordinary numbers', () => {
    expect(findSecret('key: AKIAIOSFODNN7EXAMPLE')).toBe('aws_access_key');
    expect(findSecret('-----BEGIN OPENSSH PRIVATE KEY-----\nabc')).toBe('private_key');
    expect(findSecret(`token ghp_${'a'.repeat(36)}`)).toBe('github_token');
    expect(findSecret('card 4111 1111 1111 1111 exp 12/29')).toBe('card_number');
    expect(findSecret('IBAN PT50 0002 0123 1234 5678 9015 4')).toBe('iban');
    expect(findSecret(`use mk_live_${'A1b2'.repeat(10)} to send`)).toBe('mail_gateway_key');
    expect(findSecret('Invoice INV-2026-4211 total 1234.56 EUR, order 1234567890123')).toBeNull();
    expect(findSecret('call +351 912 345 678 or ref 0000 0000 0000 0000')).toBeNull();
    expect(code(() => enforceContent(policy(), msg({ text: 'pw: postgres://admin:hunter22@db:5432/x' })))).toBe('CONTENT_BLOCKED');
    expect(code(() => enforceContent(policy({ blockSecrets: false }), msg({ text: 'AKIAIOSFODNN7EXAMPLE' })))).toBe('OK');
  });

  it('refuses executables whatever their name or type, and checks declared types', () => {
    const pdf = Buffer.from('%PDF-1.7\n...');
    const exe = Buffer.concat([Buffer.from('MZ'), randomBytes(64)]);
    expect(attachmentProblem({ filename: 'report.pdf', contentType: 'application/pdf', content: pdf }, [])).toBeNull();
    expect(attachmentProblem({ filename: 'setup.exe', contentType: 'application/octet-stream', content: pdf }, [])).toMatch(/executable/);
    expect(attachmentProblem({ filename: 'invoice.pdf', contentType: 'application/pdf', content: exe }, [])).toMatch(/executable program/);
    expect(attachmentProblem({ filename: 'a.pdf', contentType: 'application/pdf', content: Buffer.from('hello') }, [])).toMatch(/does not match/);
    expect(attachmentProblem({ filename: 'a.png', contentType: 'image/png', content: Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2]) }, ['image/*'])).toBeNull();
    expect(attachmentProblem({ filename: 'a.pdf', contentType: 'application/pdf', content: pdf }, ['image/*'])).toMatch(/allowed: image\/\*/);
  });
});

describe('ip allow-lists', () => {
  it('validates rules', () => {
    expect(['10.0.0.1', '10.0.0.0/8', '2001:db8::/32', '::1'].every(isIpRule)).toBe(true);
    expect(['10.0.0.0/33', 'example.com', '10.0.0.1/8/1', ''].some(isIpRule)).toBe(false);
  });
  it('matches addresses, ranges and IPv4-mapped IPv6', () => {
    expect(ipAllowed('10.1.2.3', [])).toBe(true);
    expect(ipAllowed('10.1.2.3', ['10.0.0.0/8'])).toBe(true);
    expect(ipAllowed('::ffff:10.1.2.3', ['10.0.0.0/8'])).toBe(true);
    expect(ipAllowed('192.168.1.1', ['10.0.0.0/8', '172.16.0.5'])).toBe(false);
    expect(ipAllowed('2001:db8::7', ['2001:db8::/32'])).toBe(true);
    expect(ipAllowed(undefined, ['10.0.0.0/8'])).toBe(false);
  });
});

describe('sending limits and warm-up', () => {
  it('parses domain limits and counts recipients per capped domain', () => {
    const l = parseDomainLimits('gmail.com=200, outlook.com=100 ,*=1000');
    expect(l.get('gmail.com')).toBe(200);
    expect(domainCounts(['a@gmail.com', 'b@GMAIL.com', 'c@example.com'], l)).toEqual([
      { domain: 'gmail.com', count: 2, limit: 200 },
      { domain: 'example.com', count: 1, limit: 1000 },
    ]);
    expect(domainCounts(['a@example.com'], parseDomainLimits('gmail.com=5'))).toEqual([]);
    expect(() => parseDomainLimits('gmail.com:5')).toThrow(/domain=number/);
  });
  it('steps through the warm-up schedule', () => {
    const s = parseWarmupSchedule('50,100,250');
    const start = new Date('2026-11-01T10:00:00Z');
    expect(warmupState(start, s, new Date('2026-11-01T12:00:00Z'))).toEqual({ day: 1, days: 3, dailyCap: 50 });
    expect(warmupState(start, s, new Date('2026-11-03T11:00:00Z'))).toEqual({ day: 3, days: 3, dailyCap: 250 });
    expect(warmupState(start, s, new Date('2026-11-04T11:00:00Z'))).toBeNull();
    expect(warmupState(null, s)).toBeNull();
    expect(() => parseWarmupSchedule('50,0')).toThrow();
  });
  it('rejects invalid specs at startup', () => {
    const base = { DATABASE_URL: 'postgresql://u:p@h/d' } as NodeJS.ProcessEnv;
    expect(() => buildConfig({ ...base, RECIPIENT_DOMAIN_LIMITS: 'gmail' })).toThrow(/RECIPIENT_DOMAIN_LIMITS/);
    expect(() => buildConfig({ ...base, WARMUP_SCHEDULE: 'a,b' })).toThrow(/WARMUP_SCHEDULE/);
  });
});

describe('templates', () => {
  const t = { name: 'reset', subject: 'Reset for {{ name }}', text: 'Hi {{name}}, code {{code}}', html: '<p>Hi {{name}}</p><p>{{code}}</p>' };
  it('lists variables', () => expect(templateVariables(t)).toEqual(['code', 'name']));
  it('renders, escaping HTML only', () => {
    const r = renderTemplate(t, { name: '<b>Ana</b>', code: 123456 });
    expect(r.subject).toBe('Reset for <b>Ana</b>');
    expect(r.text).toBe('Hi <b>Ana</b>, code 123456');
    expect(r.html).toBe('<p>Hi &lt;b&gt;Ana&lt;/b&gt;</p><p>123456</p>');
  });
  it('requires every variable, refuses unknown ones and line breaks in the subject', () => {
    expect(code(() => renderTemplate(t, { name: 'x' }))).toBe('VALIDATION_FAILED');
    expect(code(() => renderTemplate(t, { name: 'x', code: 1, extra: 2 }))).toBe('VALIDATION_FAILED');
    expect(code(() => renderTemplate(t, { name: 'x\r\nBcc: evil@x.com', code: 1 }))).toBe('VALIDATION_FAILED');
    expect(code(() => renderTemplate(t, { name: { a: 1 }, code: 1 }))).toBe('VALIDATION_FAILED');
  });
});

describe('body encryption', () => {
  const key = randomBytes(32).toString('base64');
  const c = new BodyCrypto({ APP_ENCRYPTION_KEY: key } as never);
  it('round-trips text and bytes, leaves plain legacy values readable', () => {
    const sealed = c.sealText('Olá, segredo')!;
    expect(sealed.startsWith('enc:v1:')).toBe(true);
    expect(sealed).not.toContain('segredo');
    expect(c.openText(sealed)).toBe('Olá, segredo');
    expect(c.openText('legacy plain')).toBe('legacy plain');
    expect(c.sealText(null)).toBeNull();
    const bytes = c.sealBytes(Buffer.from('%PDF-1.7'));
    expect(BodyCrypto.isSealedBytes(bytes)).toBe(true);
    expect(c.openBytes(bytes).toString()).toBe('%PDF-1.7');
    expect(c.openBytes(Buffer.from('raw')).toString()).toBe('raw');
  });
  it('detects tampering', () => {
    const sealed = c.sealText('abc')!;
    const bad = sealed.slice(0, -2) + (sealed.endsWith('A') ? 'BB' : 'AA');
    expect(() => c.openText(bad)).toThrow();
  });
  it('stores plain text without a key', () => {
    const plain = new BodyCrypto({} as never);
    expect(plain.sealText('x')).toBe('x');
  });
});

describe('audit chain hashing', () => {
  const row = { seq: 5n, at: new Date('2026-11-18T10:00:00.123Z'), actorType: 'user', actorId: 'u1', actorLabel: 'a@example.com', action: 'key.rotate', targetType: 'api_key', targetId: 'k1', details: { b: 1, a: { d: 2, c: 3 } }, ip: '10.0.0.1', outcome: 'success' };
  it('canonical JSON ignores key order', () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe(canonicalJson({ a: { c: 3, d: 2 }, b: 1 }));
  });
  it('keyed hashes change with the key, the content and the previous hash', () => {
    const k1 = new AuditChainService({} as never, { APP_ENCRYPTION_KEY: randomBytes(32).toString('base64') } as never);
    const k2 = new AuditChainService({} as never, { APP_ENCRYPTION_KEY: randomBytes(32).toString('base64') } as never);
    const h = k1.digest(row, 'hmac:prev');
    expect(h).toMatch(/^hmac:[0-9a-f]{64}$/);
    expect(k1.digest({ ...row, details: { a: { c: 3, d: 2 }, b: 1 } }, 'hmac:prev')).toBe(h);
    expect(k2.digest(row, 'hmac:prev')).not.toBe(h);
    expect(k1.digest({ ...row, outcome: 'failure' }, 'hmac:prev')).not.toBe(h);
    expect(k1.digest(row, 'hmac:other')).not.toBe(h);
    expect(new AuditChainService({} as never, {} as never).digest(row, null)).toMatch(/^sha256:/);
  });
});

describe('sender domain evaluation', () => {
  it('grades SPF', () => {
    expect(evaluateSpf(['v=spf1 include:_spf.example.com -all']).status).toBe('pass');
    expect(evaluateSpf(['v=spf1 mx ~all']).status).toBe('warn');
    expect(evaluateSpf(['v=spf1 +all']).status).toBe('fail');
    expect(evaluateSpf(['v=spf1 -all', 'v=spf1 ~all']).status).toBe('fail');
    expect(evaluateSpf(['google-site-verification=x']).status).toBe('fail');
  });
  it('grades DMARC', () => {
    expect(evaluateDmarc(['v=DMARC1; p=reject; rua=mailto:d@example.com'])).toMatchObject({ status: 'pass', policy: 'reject' });
    expect(evaluateDmarc(['v=DMARC1; p=none'])).toMatchObject({ status: 'warn', policy: 'none' });
    expect(evaluateDmarc([]).status).toBe('fail');
  });
});

describe('alert delivery formats', () => {
  const p = { id: 'e1', type: 'rejection_spike', severity: 'warning', title: '60 requests rejected', detail: { rejected: 60, topReasons: 'DUPLICATE_MESSAGE (40)' }, at: '2026-11-18T10:00:00.000Z', gateway: 'https://mail-gw.example.com' };
  it('signs webhooks over timestamp + body', () => {
    const body = JSON.stringify(p);
    expect(signWebhook('s3cret', '1700000000', body)).toBe(`sha256=${createHmac('sha256', 's3cret').update(`1700000000.${body}`).digest('hex')}`);
  });
  it('formats Slack and email', () => {
    expect(JSON.parse(slackBody(p)).text).toContain('*[warning] 60 requests rejected*');
    const e = emailContent({ ...p, title: 'a <b>\r\nc' });
    expect(e.subject).not.toMatch(/[\r\n]/);
    expect(e.html).toContain('&lt;b&gt;');
  });
});

describe('clamd client', () => {
  let server: Server;
  let port = 0;
  beforeAll(async () => {
    server = createServer((sock) => {
      const chunks: Buffer[] = [];
      sock.on('data', (d) => {
        chunks.push(d);
        const all = Buffer.concat(chunks);
        if (all.length >= 4 && all.subarray(-4).equals(Buffer.alloc(4))) {
          sock.end(all.includes(Buffer.from('EICAR')) ? 'stream: Eicar-Test-Signature FOUND\0' : 'stream: OK\0');
        }
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    port = (server.address() as { port: number }).port;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  it('reports clean and infected streams', async () => {
    expect(await clamScan('127.0.0.1', port, Buffer.from('hello'), 2000)).toEqual({ clean: true });
    expect(await clamScan('127.0.0.1', port, Buffer.from('X5O!P%@AP EICAR test'), 2000)).toEqual({ clean: false, signature: 'Eicar-Test-Signature' });
  });
  it('fails when the scanner is unreachable', async () => {
    await expect(clamScan('127.0.0.1', 1, Buffer.from('x'), 1000)).rejects.toThrow();
  });
});
