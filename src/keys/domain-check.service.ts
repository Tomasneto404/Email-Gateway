// Authored by Tomás Neto (TN 2026)
import { Inject, Injectable } from '@nestjs/common';
import { promises as dns } from 'node:dns';
import type { Redis } from 'ioredis';
import { APP_CONFIG, AppConfig } from '../config/config';
import { GatewayError } from '../common/errors';
import { REDIS } from '../common/redis';

export type CheckStatus = 'pass' | 'warn' | 'fail';

export interface DomainCheckItem {
  status: CheckStatus;
  record: string | null;
  note: string;
}

export interface DomainCheckResult {
  domain: string;
  mode: 'off' | 'warn' | 'enforce';
  checkedAt: string;
  spf: DomainCheckItem;
  dmarc: DomainCheckItem & { policy: string | null };
  dkim: DomainCheckItem & { selector: string | null };
  /** spf and dmarc pass (dkim is advisory: its selector is not always discoverable) */
  ok: boolean;
}

/** SPF: present, single, and ends in -all (pass) or ~all (warn). */
export function evaluateSpf(txt: string[]): DomainCheckItem {
  const spf = txt.filter((t) => /^v=spf1(\s|$)/i.test(t.trim()));
  if (!spf.length) return { status: 'fail', record: null, note: 'No SPF record: receivers cannot tell which servers may send for this domain.' };
  if (spf.length > 1) return { status: 'fail', record: spf.join(' | '), note: 'More than one SPF record: SPF evaluates as a permanent error.' };
  const r = spf[0].trim();
  if (/\s-all\b/i.test(r)) return { status: 'pass', record: r, note: 'Hard fail for other senders (-all).' };
  if (/\s~all\b/i.test(r)) return { status: 'warn', record: r, note: 'Soft fail (~all): consider -all once every sender is listed.' };
  if (/\s\+?all\b/i.test(r)) return { status: 'fail', record: r, note: '"+all" lets anyone send as this domain.' };
  return { status: 'warn', record: r, note: 'No "all" mechanism: other senders are neutral.' };
}

/** DMARC: present with p=reject/quarantine (pass) or p=none (warn). */
export function evaluateDmarc(txt: string[]): DomainCheckItem & { policy: string | null } {
  const rec = txt.find((t) => /^v=DMARC1\s*;/i.test(t.trim()));
  if (!rec) return { status: 'fail', record: null, policy: null, note: 'No DMARC record at _dmarc.<domain>.' };
  const policy = /(?:^|;)\s*p\s*=\s*(\w+)/i.exec(rec)?.[1]?.toLowerCase() ?? null;
  if (policy === 'reject' || policy === 'quarantine') return { status: 'pass', record: rec.trim(), policy, note: `Policy ${policy}.` };
  if (policy === 'none') return { status: 'warn', record: rec.trim(), policy, note: 'Policy none: monitoring only, spoofed mail is still delivered.' };
  return { status: 'fail', record: rec.trim(), policy, note: 'DMARC record without a valid p= policy.' };
}

const flat = (records: string[][]) => records.map((r) => r.join(''));

/**
 * Optional sender-domain checks (SENDER_DOMAIN_CHECKS): SPF, DMARC and DKIM (common selectors) by DNS.
 * Results are cached for an hour. In "enforce" mode a key cannot leave sandbox while SPF or DMARC fail.
 */
@Injectable()
export class DomainCheckService {
  constructor(
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  get mode() {
    return this.cfg.SENDER_DOMAIN_CHECKS;
  }

  private async txt(name: string): Promise<string[]> {
    try {
      return flat(await Promise.race([dns.resolveTxt(name), new Promise<never>((_, rej) => setTimeout(() => rej(new Error('timeout')), 4000))]));
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === 'ENOTFOUND' || code === 'ENODATA') return [];
      throw e;
    }
  }

  async check(domain: string, fresh = false): Promise<DomainCheckResult> {
    const d = domain.trim().toLowerCase();
    const cacheKey = `mg:domaincheck:${d}`;
    if (!fresh) {
      const hit = await this.redis.get(cacheKey);
      if (hit) return { ...(JSON.parse(hit) as DomainCheckResult), mode: this.mode };
    }
    let spfTxt: string[];
    let dmarcTxt: string[];
    try {
      [spfTxt, dmarcTxt] = await Promise.all([this.txt(d), this.txt(`_dmarc.${d}`)]);
    } catch (e) {
      throw new GatewayError('INTERNAL_ERROR', `DNS lookup for ${d} failed: ${(e as Error).message}. Check the gateway's DNS access.`);
    }
    let dkim: DomainCheckResult['dkim'] = { status: 'warn', record: null, selector: null, note: 'No DKIM key found for the common selectors; it may use another selector.' };
    for (const sel of this.cfg.DKIM_SELECTORS.split(',').map((s) => s.trim()).filter(Boolean)) {
      const rec = (await this.txt(`${sel}._domainkey.${d}`).catch(() => [])).find((t) => /(^|;)\s*p=/i.test(t));
      if (rec) {
        dkim = /(^|;)\s*p=\s*(;|$)/i.test(rec)
          ? { status: 'fail', record: rec, selector: sel, note: `Selector ${sel} is revoked (empty p=).` }
          : { status: 'pass', record: rec.slice(0, 120) + (rec.length > 120 ? '…' : ''), selector: sel, note: `Key published for selector ${sel}.` };
        break;
      }
    }
    const spf = evaluateSpf(spfTxt);
    const dmarc = evaluateDmarc(dmarcTxt);
    const result: DomainCheckResult = { domain: d, mode: this.mode, checkedAt: new Date().toISOString(), spf, dmarc, dkim, ok: spf.status !== 'fail' && dmarc.status !== 'fail' };
    await this.redis.set(cacheKey, JSON.stringify(result), 'EX', 3600);
    return result;
  }

  /** Called before a key leaves sandbox. */
  async assertReadyForLive(fromAddress: string): Promise<void> {
    if (this.mode !== 'enforce') return;
    const domain = fromAddress.slice(fromAddress.lastIndexOf('@') + 1);
    const r = await this.check(domain, true);
    if (!r.ok) {
      const failing = [r.spf.status === 'fail' ? `SPF: ${r.spf.note}` : '', r.dmarc.status === 'fail' ? `DMARC: ${r.dmarc.note}` : ''].filter(Boolean);
      throw new GatewayError('DOMAIN_NOT_VERIFIED', `The sender domain ${domain} is not ready for live mail. ${failing.join(' ')}`, { domain, spf: r.spf, dmarc: r.dmarc });
    }
  }
}
