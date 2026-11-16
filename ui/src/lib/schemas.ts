import { z } from 'zod';

/** Mirrors the backend validators (src/common/validators.ts). */
export const EMAIL_RE = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}$/;
export const DOMAIN_RULE_RE = /^@(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}$/;

export const isEmail = (v: string) => EMAIL_RE.test(v) && !v.includes('..') && v.length <= 254;
export const isRecipientRule = (v: string) => isEmail(v) || DOMAIN_RULE_RE.test(v);

const noCrlf = (v: string) => !/[\r\n]/.test(v);
const MB = 1024 * 1024;
const int = (min: number, max: number) =>
  z
    .number({ message: 'Required' })
    .int('Whole numbers only')
    .min(min, `Must be ${min} or more`)
    .max(max, `Must be at most ${max.toLocaleString()}`);

export const policySchema = z.object({
  description: z.string().max(500),
  mode: z.enum(['sandbox', 'live', 'approval']),
  fromAddress: z.string().trim().toLowerCase().refine(isEmail, 'Enter a plain email address'),
  fromName: z.string().max(100).refine(noCrlf, 'No line breaks'),
  allowReplyTo: z.boolean(),
  allowedRecipients: z.array(z.string().refine(isRecipientRule, 'Invalid entry')).max(500),
  maxRecipientsPerMessage: int(1, 1000),
  maxMessageBytes: int(1, 50 * MB),
  quotaPerHour: int(0, 1_000_000),
  quotaPerDay: int(0, 10_000_000),
  attachmentsAllowed: z.boolean(),
  maxAttachmentBytes: int(0, 40 * MB),
  liveProvider: z.enum(['default', 'smtp', 'resend']),
});
export type PolicyForm = z.infer<typeof policySchema>;

export const keyNameSchema = z
  .string()
  .min(2, 'At least 2 characters')
  .max(64)
  .regex(/^[A-Za-z0-9._-]+$/, 'Letters, digits, ".", "_" and "-" only');
