import { GatewayError } from '../common/errors';
import { MessageStatus, Prisma } from '../generated/prisma/client';
import { qDate, qEnum, qInt, qList, qStr } from './query';

/** Shared filter parsing for list endpoints and CSV exports (same semantics everywhere). */

export const STATUSES: MessageStatus[] = ['queued', 'pending_approval', 'sent', 'failed', 'rejected', 'captured'];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function qUuid(v: unknown, name: string): string | undefined {
  if (v === undefined || v === '') return undefined;
  if (typeof v !== 'string' || !UUID_RE.test(v)) throw new GatewayError('VALIDATION_FAILED', `${name} must be a UUID.`);
  return v;
}

export interface MessageQuery {
  status?: MessageStatus[];
  keyId?: string;
  recipient?: string;
  subject?: string;
  from?: Date;
  to?: Date;
  page?: number;
  pageSize?: number;
  sort?: 'createdAt' | 'status' | 'subject';
  order?: 'asc' | 'desc';
}

export function parseMessageQuery(q: Record<string, string>): MessageQuery {
  return {
    status: qList(q.status, STATUSES),
    keyId: qUuid(q.keyId, 'keyId'),
    recipient: qStr(q.recipient, 320),
    subject: qStr(q.subject),
    from: qDate(q.from),
    to: qDate(q.to),
    page: qInt(q.page),
    pageSize: qInt(q.pageSize),
    sort: qEnum(q.sort, ['createdAt', 'status', 'subject'] as const),
    order: qEnum(q.order, ['asc', 'desc'] as const),
  };
}

export function messageWhere(q: MessageQuery): Prisma.MessageWhereInput {
  const r = q.recipient?.toLowerCase();
  return {
    ...(q.status?.length ? { status: { in: q.status } } : {}),
    ...(q.keyId ? { apiKeyId: q.keyId } : {}),
    ...(r ? { OR: [{ to: { has: r } }, { cc: { has: r } }, { bcc: { has: r } }] } : {}),
    ...(q.subject ? { subject: { contains: q.subject, mode: 'insensitive' } } : {}),
    ...(q.from || q.to ? { createdAt: { ...(q.from ? { gte: q.from } : {}), ...(q.to ? { lte: q.to } : {}) } } : {}),
  };
}

export interface AuditQuery {
  action?: string;
  actor?: string;
  actorType?: 'user' | 'token' | 'cli' | 'system';
  /** activity performed by this admin user */
  actorId?: string;
  /** activity performed on this API key */
  keyId?: string;
  outcome?: 'success' | 'failure';
  from?: Date;
  to?: Date;
  page?: number;
  pageSize?: number;
  order?: 'asc' | 'desc';
}

export function parseAuditQuery(q: Record<string, string>): AuditQuery {
  return {
    action: qStr(q.action, 100),
    actor: qStr(q.actor, 254),
    actorType: qEnum(q.actorType, ['user', 'token', 'cli', 'system'] as const),
    actorId: qUuid(q.actorId, 'actorId'),
    keyId: qUuid(q.keyId, 'keyId'),
    outcome: qEnum(q.outcome, ['success', 'failure'] as const),
    from: qDate(q.from),
    to: qDate(q.to),
    page: qInt(q.page),
    pageSize: qInt(q.pageSize),
    order: qEnum(q.order, ['asc', 'desc'] as const),
  };
}

export function auditWhere(q: AuditQuery): Prisma.AdminAuditWhereInput {
  return {
    ...(q.action ? { action: { startsWith: q.action } } : {}),
    ...(q.actor ? { actorLabel: { contains: q.actor, mode: 'insensitive' } } : {}),
    ...(q.actorType ? { actorType: q.actorType } : {}),
    ...(q.actorId ? { actorId: q.actorId } : {}),
    ...(q.keyId ? { targetType: 'api_key', targetId: q.keyId } : {}),
    ...(q.outcome ? { outcome: q.outcome } : {}),
    ...(q.from || q.to ? { at: { ...(q.from ? { gte: q.from } : {}), ...(q.to ? { lte: q.to } : {}) } } : {}),
  };
}
