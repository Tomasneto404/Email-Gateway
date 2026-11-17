// Authored by Tomás Neto (TN 2026)
import { Inject, Injectable } from '@nestjs/common';
import type { Response } from 'express';
import { APP_CONFIG, AppConfig } from '../config/config';
import { CSV_BOM, CsvDelimiter, csvRow, fileSafe } from '../common/csv';
import { PrismaService } from '../common/prisma.service';
import { Actor, AdminAuditService } from './admin-audit.service';
import { AuditQuery, MessageQuery, auditWhere, messageWhere } from './filters';

const BATCH = 1000;

const MESSAGE_COLUMNS = [
  'id', 'created_at', 'sent_at', 'status', 'key_name', 'key_id', 'mode', 'provider', 'source',
  'from', 'to', 'cc', 'bcc', 'reply_to', 'subject', 'reject_code', 'reject_reason', 'attempts',
  'delivery_outcome', 'size_bytes', 'source_ip', 'last_error', 'provider_message_id',
] as const;

const AUDIT_COLUMNS = ['id', 'at', 'actor_type', 'actor', 'actor_id', 'action', 'outcome', 'target_type', 'target_id', 'ip', 'details'] as const;

/**
 * Streams CSV exports in keyset-paginated batches (constant memory, no full scans in one query).
 * Message bodies are never exported. Every export is itself recorded in the activity log.
 */
@Injectable()
export class ExportService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AdminAuditService,
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
  ) {}

  private begin(res: Response, filename: string, total: number) {
    const limited = Math.min(total, this.cfg.EXPORT_MAX_ROWS);
    res.status(200);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Export-Rows', String(limited));
    res.setHeader('X-Export-Truncated', String(total > this.cfg.EXPORT_MAX_ROWS));
    res.write(CSV_BOM);
    return limited;
  }

  async messages(q: MessageQuery, delimiter: CsvDelimiter, actor: Actor, res: Response) {
    const where = messageWhere(q);
    const total = await this.prisma.message.count({ where });
    let keyName = 'all';
    if (q.keyId) keyName = (await this.prisma.apiKey.findUnique({ where: { id: q.keyId }, select: { name: true } }))?.name ?? q.keyId;
    const limit = this.begin(res, `messages-${fileSafe(keyName)}-${new Date().toISOString().slice(0, 10)}.csv`, total);
    res.write(csvRow([...MESSAGE_COLUMNS], delimiter));

    let written = 0;
    let cursor: string | undefined;
    while (written < limit) {
      const rows = await this.prisma.message.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: Math.min(BATCH, limit - written),
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
        select: {
          id: true, createdAt: true, sentAt: true, status: true, apiKeyId: true, deliveryMode: true, provider: true, source: true,
          fromAddress: true, fromName: true, to: true, cc: true, bcc: true, replyTo: true, subject: true, rejectCode: true,
          rejectReason: true, attempts: true, deliveryOutcome: true, sizeBytes: true, sourceIp: true, lastError: true,
          providerMessageId: true, apiKey: { select: { name: true } },
        },
      });
      if (!rows.length) break;
      let chunk = '';
      for (const m of rows) {
        chunk += csvRow(
          [
            m.id, m.createdAt, m.sentAt, m.status, m.apiKey.name, m.apiKeyId, m.deliveryMode, m.provider, m.source,
            m.fromName ? `${m.fromName} <${m.fromAddress}>` : m.fromAddress, m.to, m.cc, m.bcc, m.replyTo, m.subject,
            m.rejectCode, m.rejectReason, m.attempts, m.deliveryOutcome, m.sizeBytes, m.sourceIp, m.lastError, m.providerMessageId,
          ],
          delimiter,
        );
      }
      if (!res.write(chunk)) await new Promise((r) => res.once('drain', r));
      written += rows.length;
      cursor = rows[rows.length - 1].id;
    }
    res.end();
    await this.audit.record(actor, {
      action: 'export.messages',
      targetType: q.keyId ? 'api_key' : undefined,
      targetId: q.keyId,
      details: { rows: written, truncated: total > limit, filters: serializable(q) },
    });
  }

  async auditLog(q: AuditQuery, delimiter: CsvDelimiter, actor: Actor, res: Response) {
    const where = auditWhere(q);
    const total = await this.prisma.adminAudit.count({ where });
    let scope = 'all';
    if (q.actorId) scope = `user-${(await this.prisma.adminUser.findUnique({ where: { id: q.actorId }, select: { email: true } }))?.email ?? q.actorId}`;
    else if (q.keyId) scope = `key-${(await this.prisma.apiKey.findUnique({ where: { id: q.keyId }, select: { name: true } }))?.name ?? q.keyId}`;
    const limit = this.begin(res, `activity-${fileSafe(scope)}-${new Date().toISOString().slice(0, 10)}.csv`, total);
    res.write(csvRow([...AUDIT_COLUMNS], delimiter));

    let written = 0;
    let cursor: string | undefined;
    const order = q.order ?? 'desc';
    while (written < limit) {
      const rows = await this.prisma.adminAudit.findMany({
        where,
        orderBy: [{ at: order }, { id: order }],
        take: Math.min(BATCH, limit - written),
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      });
      if (!rows.length) break;
      let chunk = '';
      for (const a of rows) {
        chunk += csvRow([a.id, a.at, a.actorType, a.actorLabel, a.actorId, a.action, a.outcome, a.targetType, a.targetId, a.ip, a.details], delimiter);
      }
      if (!res.write(chunk)) await new Promise((r) => res.once('drain', r));
      written += rows.length;
      cursor = rows[rows.length - 1].id;
    }
    res.end();
    await this.audit.record(actor, {
      action: 'export.activity',
      targetType: q.keyId ? 'api_key' : q.actorId ? 'admin_user' : undefined,
      targetId: q.keyId ?? q.actorId,
      details: { rows: written, truncated: total > limit, filters: serializable(q) },
    });
  }
}

function serializable(q: object) {
  return Object.fromEntries(Object.entries(q).filter(([, v]) => v !== undefined).map(([k, v]) => [k, v instanceof Date ? v.toISOString() : v]));
}
