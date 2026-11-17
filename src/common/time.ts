// Authored by Tomás Neto (TN 2026)
export function hourBucket(d = new Date()): Date {
  const b = new Date(d);
  b.setUTCMinutes(0, 0, 0);
  return b;
}

/** yyyymmddhh / yyyymmdd UTC window ids + seconds until the window ends. */
export function windows(now = new Date()) {
  const iso = now.toISOString();
  const day = iso.slice(0, 10).replace(/-/g, '');
  const hour = day + iso.slice(11, 13);
  const hourEnd = hourBucket(now).getTime() + 3600_000;
  const dayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const dayEnd = dayStart.getTime() + 86_400_000;
  return {
    hour,
    day,
    hourResetSeconds: Math.max(1, Math.ceil((hourEnd - now.getTime()) / 1000)),
    dayResetSeconds: Math.max(1, Math.ceil((dayEnd - now.getTime()) / 1000)),
  };
}
