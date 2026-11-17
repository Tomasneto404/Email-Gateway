// Authored by Tomás Neto (TN 2026)
/** Mirrors src/auth/permissions.ts hasPermission (UI gating only; the server enforces). */
export function hasPermission(granted: readonly string[] | undefined, needed: string): boolean {
  if (!granted) return false;
  if (granted.includes('*') || granted.includes(needed)) return true;
  if (needed.endsWith(':*')) return false;
  return granted.includes(`${needed.split(':')[0]}:*`);
}

export const canAny = (granted: readonly string[] | undefined, perms: readonly string[]) => perms.some((p) => hasPermission(granted, p));

/** Mirrors the server's anti-escalation check: can a holder of `granted` hand out `requested`? */
export function covers(granted: readonly string[] | undefined, requested: readonly string[]): boolean {
  if (!granted) return false;
  if (granted.includes('*')) return true;
  return requested.every((r) => r !== '*' && hasPermission(granted, r));
}
