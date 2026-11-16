import * as argon2 from 'argon2';
import { GatewayError } from '../common/errors';

/** argon2id, OWASP-recommended parameters (m=19 MiB, t=2, p=1). */
const OPTS = { type: argon2.argon2id, memoryCost: 19_456, timeCost: 2, parallelism: 1 } as const;

export const MIN_PASSWORD_LENGTH = 12;

export function assertPasswordPolicy(pw: unknown): asserts pw is string {
  if (typeof pw !== 'string' || pw.length < MIN_PASSWORD_LENGTH || pw.length > 256) {
    throw new GatewayError('VALIDATION_FAILED', `Password must be between ${MIN_PASSWORD_LENGTH} and 256 characters.`);
  }
}

export const hashPassword = (pw: string) => argon2.hash(pw, OPTS);

export async function verifyPassword(hash: string | null | undefined, pw: string): Promise<boolean> {
  if (!hash) {
    // equalize timing for unknown users / SSO-only users
    await argon2.hash(pw, OPTS).catch(() => undefined);
    return false;
  }
  try {
    return await argon2.verify(hash, pw);
  } catch {
    return false;
  }
}
