import { registerDecorator, ValidationOptions } from 'class-validator';

export const CRLF_RE = /[\r\n]/;

/** Rejects CR/LF anywhere in the value (header injection protection). Arrays are checked element-wise. */
export function NoCrlf(options?: ValidationOptions) {
  return (object: object, propertyName: string) =>
    registerDecorator({
      name: 'noCrlf',
      target: object.constructor,
      propertyName,
      options: { message: `${propertyName} must not contain line breaks (CR/LF)`, ...options },
      validator: {
        validate(value: unknown) {
          if (value === undefined || value === null) return true;
          const vals = Array.isArray(value) ? value : [value];
          return vals.every((v) => typeof v !== 'string' || !CRLF_RE.test(v));
        },
      },
    });
}

/**
 * Strict plain address check: local@domain, no display names, no whitespace, no angle brackets.
 * Intentionally conservative: the gateway never needs exotic address syntax.
 */
const EMAIL_RE = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}$/;
export function isPlainEmail(v: unknown): v is string {
  return typeof v === 'string' && v.length <= 254 && EMAIL_RE.test(v) && !v.includes('..');
}

const DOMAIN_RE = /^@(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}$/;
/** Allowed-recipient entry: an exact address or `@domain`. */
export function isRecipientRule(v: unknown): v is string {
  return typeof v === 'string' && (isPlainEmail(v) || DOMAIN_RE.test(v));
}

export function IsPlainEmail(options?: ValidationOptions) {
  return (object: object, propertyName: string) =>
    registerDecorator({
      name: 'isPlainEmail',
      target: object.constructor,
      propertyName,
      options: {
        message: `${propertyName} must contain only plain email addresses like "user@example.com" (no display names)`,
        ...options,
      },
      validator: {
        validate(value: unknown) {
          if (value === undefined || value === null) return true;
          const vals = Array.isArray(value) ? value : [value];
          return vals.every(isPlainEmail);
        },
      },
    });
}

export function IsRecipientRule(options?: ValidationOptions) {
  return (object: object, propertyName: string) =>
    registerDecorator({
      name: 'isRecipientRule',
      target: object.constructor,
      propertyName,
      options: {
        message: `${propertyName} entries must be an exact address ("ops@example.com") or a domain ("@example.com")`,
        ...options,
      },
      validator: {
        validate(value: unknown) {
          if (!Array.isArray(value)) return false;
          return value.every(isRecipientRule);
        },
      },
    });
}
