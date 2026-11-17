// Authored by Tomás Neto (TN 2026)
import { createServer, IncomingMessage, Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { shouldTrip } from '../../src/worker/circuit-breaker';
import { OutboundMessage } from '../../src/worker/providers/provider';
import { ResendApiError, ResendProvider, classifyResendError, sanitizeTag, toResendPayload } from '../../src/worker/providers/resend.provider';
import { classifySmtpError } from '../../src/worker/providers/smtp.provider';

describe('SMTP error classification', () => {
  it('4xx is transient, 5xx is permanent', () => {
    expect(classifySmtpError({ responseCode: 451, response: '451 try later' })).toMatchObject({ transient: true, systemic: false });
    expect(classifySmtpError({ responseCode: 550, response: '550 no such user' })).toMatchObject({ transient: false, systemic: false });
  });
  it('connection errors are transient and systemic', () => {
    for (const code of ['ECONNECTION', 'ETIMEDOUT', 'ESOCKET', 'EDNS']) {
      expect(classifySmtpError({ code, message: 'boom' })).toMatchObject({ transient: true, systemic: true });
    }
  });
  it('server-wide replies count for the breaker', () => {
    expect(classifySmtpError({ responseCode: 421 })).toMatchObject({ transient: true, systemic: true });
    expect(classifySmtpError({ code: 'EAUTH', responseCode: 535 })).toMatchObject({ transient: false, systemic: true });
  });
});

describe('Resend error classification', () => {
  it('429 / 5xx / network → transient; validation → permanent', () => {
    expect(classifyResendError(new ResendApiError('rate_limit_exceeded', 429, 'slow down')).transient).toBe(true);
    expect(classifyResendError(new ResendApiError('internal_server_error', 500, 'oops')).transient).toBe(true);
    expect(classifyResendError(new ResendApiError('application_error', null, 'fetch failed')).transient).toBe(true);
    expect(classifyResendError(new ResendApiError('validation_error', 422, 'bad to'))).toMatchObject({ transient: false, systemic: false });
    expect(classifyResendError(new ResendApiError('invalid_from_address', 403, 'domain not verified'))).toMatchObject({ transient: false, systemic: true });
  });
});

describe('circuit breaker decision', () => {
  const c = { consecutiveFailures: 3, failureRate: 0.5, minSamples: 4 };
  it('trips on consecutive failures', () => expect(shouldTrip({ consecutive: 3, samples: 3, failures: 3 }, c)).toBe('consecutive'));
  it('trips on failure rate with enough samples', () => expect(shouldTrip({ consecutive: 0, samples: 4, failures: 2 }, c)).toBe('failure_rate'));
  it('does not trip with too few samples', () => expect(shouldTrip({ consecutive: 1, samples: 3, failures: 2 }, c)).toBe(false));
  it('does not trip below the rate', () => expect(shouldTrip({ consecutive: 0, samples: 10, failures: 4 }, c)).toBe(false));
});

const outbound: OutboundMessage = {
  gatewayMessageId: '0190-abc',
  keyName: 'agent.one',
  headerMessageId: '<0190-abc@example.com>',
  from: { address: 'bot@example.com', name: 'Bot "X"' },
  to: ['a@example.com'],
  cc: [],
  bcc: ['b@example.com'],
  replyTo: null,
  subject: 'Hi',
  text: 'hello',
  html: null,
  attachments: [{ filename: 'a.txt', contentType: 'text/plain', content: Buffer.from('hi') }],
  headers: { 'X-Mail-Gateway-Key': 'agent.one', 'X-Mail-Gateway-Message-Id': '0190-abc' },
};

describe('Resend payload mapping', () => {
  it('maps fields, headers, tags and attachments', () => {
    const p = toResendPayload(outbound);
    expect(p).toMatchObject({
      from: 'Bot X <bot@example.com>',
      to: ['a@example.com'],
      bcc: ['b@example.com'],
      subject: 'Hi',
      text: 'hello',
      headers: { 'X-Mail-Gateway-Key': 'agent.one', 'X-Mail-Gateway-Message-Id': '0190-abc', 'Message-ID': '<0190-abc@example.com>' },
      attachments: [{ filename: 'a.txt', content: 'aGk=', contentType: 'text/plain' }],
    });
    expect(p).not.toHaveProperty('cc');
    expect(p.tags).toEqual([
      { name: 'gateway_key', value: 'agent_one' },
      { name: 'gateway_message_id', value: '0190-abc' },
    ]);
    expect(sanitizeTag('a b.c')).toBe('a_b_c');
  });
});

describe('ResendProvider against a stub API', () => {
  let server: Server;
  let baseUrl: string;
  const seen: Array<{ headers: IncomingMessage['headers']; body: Record<string, unknown> }> = [];
  let reply: { status: number; body: unknown } = { status: 200, body: { id: 're_123' } };

  beforeAll(async () => {
    server = createServer((req, res) => {
      let data = '';
      req.on('data', (c) => (data += c));
      req.on('end', () => {
        seen.push({ headers: req.headers, body: JSON.parse(data || '{}') });
        res.writeHead(reply.status, { 'content-type': 'application/json' }).end(JSON.stringify(reply.body));
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  it('sends with Idempotency-Key = gateway message id and returns the Resend id', async () => {
    reply = { status: 200, body: { id: 're_123' } };
    const p = new ResendProvider('re_test_key', baseUrl);
    const res = await p.send(outbound);
    expect(res.providerMessageId).toBe('re_123');
    const last = seen.at(-1)!;
    expect(last.headers['idempotency-key']).toBe('0190-abc');
    expect(last.headers.authorization).toBe('Bearer re_test_key');
    expect(last.body.subject).toBe('Hi');
  });

  it('422 → permanent failure', async () => {
    reply = { status: 422, body: { statusCode: 422, name: 'validation_error', message: 'Invalid `to` field' } };
    const p = new ResendProvider('re_test_key', baseUrl);
    const err = await p.send(outbound).catch((e) => e);
    expect(err).toBeInstanceOf(ResendApiError);
    expect(p.classify(err).transient).toBe(false);
  });

  it('429 → transient (retry)', async () => {
    reply = { status: 429, body: { statusCode: 429, name: 'rate_limit_exceeded', message: 'Too many requests' } };
    const p = new ResendProvider('re_test_key', baseUrl);
    const err = await p.send(outbound).catch((e) => e);
    expect(p.classify(err).transient).toBe(true);
  });
});
