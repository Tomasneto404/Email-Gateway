// Authored by Tomás Neto (TN 2026)

/** "gmail.com=200,outlook.com=200,*=1000" → Map(domain → hourly cap). `*` is every other domain. */
export function parseDomainLimits(spec: string): Map<string, number> {
  const out = new Map<string, number>();
  for (const part of spec.split(',').map((s) => s.trim()).filter(Boolean)) {
    const m = /^(\*|[a-z0-9.-]+\.[a-z]{2,}|[a-z0-9-]+)\s*=\s*(\d+)$/i.exec(part);
    if (!m) throw new Error(`RECIPIENT_DOMAIN_LIMITS: "${part}" must look like "domain=number" (or "*=number")`);
    out.set(m[1].toLowerCase(), Number(m[2]));
  }
  return out;
}

/** "50,100,250" → [50, 100, 250]: daily caps for day 1, 2, 3, … after a key leaves sandbox. */
export function parseWarmupSchedule(spec: string): number[] {
  const parts = spec.split(',').map((s) => s.trim()).filter(Boolean);
  return parts.map((p) => {
    if (!/^\d+$/.test(p) || Number(p) < 1) throw new Error(`WARMUP_SCHEDULE: "${p}" must be a positive integer`);
    return Number(p);
  });
}

/** Recipient count per domain for the domains that have a cap (explicit or `*`). */
export function domainCounts(recipients: string[], limits: Map<string, number>): Array<{ domain: string; count: number; limit: number }> {
  const counts = new Map<string, number>();
  for (const r of recipients) {
    const d = r.slice(r.lastIndexOf('@') + 1).toLowerCase();
    counts.set(d, (counts.get(d) ?? 0) + 1);
  }
  const out: Array<{ domain: string; count: number; limit: number }> = [];
  for (const [domain, count] of counts) {
    const limit = limits.get(domain) ?? limits.get('*') ?? 0;
    if (limit > 0) out.push({ domain, count, limit });
  }
  return out;
}

export interface WarmupState {
  /** 1-based day of the warm-up */
  day: number;
  days: number;
  dailyCap: number;
}

/** The warm-up cap that applies now, or null when the key is past (or not in) its warm-up. */
export function warmupState(liveSince: Date | null, schedule: number[], now = new Date()): WarmupState | null {
  if (!liveSince || !schedule.length) return null;
  const idx = Math.floor((now.getTime() - liveSince.getTime()) / 86_400_000);
  if (idx < 0 || idx >= schedule.length) return null;
  return { day: idx + 1, days: schedule.length, dailyCap: schedule[idx] };
}
