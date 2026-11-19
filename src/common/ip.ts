// Authored by Tomás Neto (TN 2026)
import { BlockList, isIP } from 'node:net';

/** "10.0.0.5", "10.0.0.0/24", "2001:db8::/32" */
export function isIpRule(rule: string): boolean {
  const [addr, bits, extra] = rule.trim().split('/');
  if (extra !== undefined) return false;
  const v = isIP(addr);
  if (!v) return false;
  if (bits === undefined) return true;
  if (!/^\d{1,3}$/.test(bits)) return false;
  const n = Number(bits);
  return v === 4 ? n <= 32 : n <= 128;
}

/** IPv4-mapped IPv6 ("::ffff:10.0.0.5") as plain IPv4. */
export function normalizeIp(ip: string): string {
  const m = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  return m ? m[1] : ip;
}

/** Is `ip` inside any of the rules (single addresses or CIDR ranges)? Empty rules = allow all. */
export function ipAllowed(ip: string | undefined, rules: string[]): boolean {
  if (!rules.length) return true;
  if (!ip) return false;
  const addr = normalizeIp(ip);
  const family = isIP(addr);
  if (!family) return false;
  const list = new BlockList();
  for (const r of rules) {
    const [a, bits] = r.trim().split('/');
    const fam = isIP(a) === 6 ? 'ipv6' : 'ipv4';
    if (bits === undefined) list.addAddress(a, fam);
    else list.addSubnet(a, Number(bits), fam);
  }
  return list.check(addr, family === 6 ? 'ipv6' : 'ipv4');
}
