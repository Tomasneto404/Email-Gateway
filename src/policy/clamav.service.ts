// Authored by Tomás Neto (TN 2026)
import { Inject, Injectable } from '@nestjs/common';
import { connect } from 'node:net';
import { APP_CONFIG, AppConfig } from '../config/config';
import { GatewayError } from '../common/errors';
import { NormalizedAttachment } from './policy-engine';

export type ScanResult = { clean: true } | { clean: false; signature: string };

/** One clamd INSTREAM scan: "zINSTREAM\0", <u32 length><chunk>…, <u32 0>; reply "stream: OK" or "stream: <sig> FOUND". */
export function clamScan(host: string, port: number, data: Buffer, timeoutMs: number): Promise<ScanResult> {
  return new Promise((resolve, reject) => {
    const sock = connect({ host, port });
    const chunks: Buffer[] = [];
    let settled = false;
    const done = (fn: () => void) => {
      if (settled) return;
      settled = true;
      sock.destroy();
      fn();
    };
    sock.setTimeout(timeoutMs, () => done(() => reject(new Error('clamd timed out'))));
    sock.on('error', (e) => done(() => reject(e)));
    sock.on('data', (d) => chunks.push(d));
    sock.on('end', () => {
      const reply = Buffer.concat(chunks).toString('utf8').replace(/\0/g, '').trim();
      done(() => {
        if (/:\s*OK$/.test(reply)) resolve({ clean: true });
        else if (/FOUND$/.test(reply)) resolve({ clean: false, signature: reply.replace(/^.*?:\s*/, '').replace(/\s*FOUND$/, '') });
        else reject(new Error(`unexpected clamd reply: ${reply.slice(0, 200)}`));
      });
    });
    sock.on('connect', () => {
      sock.write('zINSTREAM\0');
      for (let i = 0; i < data.length; i += 64 * 1024) {
        const chunk = data.subarray(i, i + 64 * 1024);
        const len = Buffer.alloc(4);
        len.writeUInt32BE(chunk.length);
        sock.write(len);
        sock.write(chunk);
      }
      sock.write(Buffer.alloc(4));
    });
  });
}

/** Attachment scanning for keys with scanAttachments. Fails closed: no scanner, no attachment. */
@Injectable()
export class ClamavService {
  constructor(@Inject(APP_CONFIG) private readonly cfg: AppConfig) {}

  get configured() {
    return !!this.cfg.CLAMAV_HOST;
  }

  async assertClean(keyName: string, attachments: NormalizedAttachment[]): Promise<void> {
    if (!attachments.length) return;
    if (!this.cfg.CLAMAV_HOST) {
      throw new GatewayError(
        'ATTACHMENT_SCAN_UNAVAILABLE',
        `Key "${keyName}" requires attachments to be virus-scanned but no scanner is configured on the gateway. Send without attachments or contact an administrator.`,
      );
    }
    for (const a of attachments) {
      let r: ScanResult;
      try {
        r = await clamScan(this.cfg.CLAMAV_HOST, this.cfg.CLAMAV_PORT, a.content, this.cfg.CLAMAV_TIMEOUT_MS);
      } catch (e) {
        throw new GatewayError('ATTACHMENT_SCAN_UNAVAILABLE', `The virus scanner is unavailable (${(e as Error).message}). Retry later.`, { retryAfterSeconds: 60 });
      }
      if (!r.clean) {
        throw new GatewayError('ATTACHMENT_INFECTED', `Attachment "${a.filename}" was flagged by the virus scanner (${r.signature}). It will not be sent.`, {
          filename: a.filename,
          signature: r.signature,
        });
      }
    }
  }
}
