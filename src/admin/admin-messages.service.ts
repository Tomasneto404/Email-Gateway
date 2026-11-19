// Authored by Tomás Neto (TN 2026)
import { Injectable } from '@nestjs/common';
import { BodyCrypto } from '../common/body-crypto';
import { EventLogger } from '../common/event-logger';
import { GatewayError } from '../common/errors';
import { PrismaService } from '../common/prisma.service';
import { MessageStatus, Prisma } from '../generated/prisma/client';
import { MessagesRepository } from '../messages/messages.repository';
import { MessageQuery, messageWhere } from './filters';
import { QueueService } from '../queue/queue.service';
import { Actor, AdminAuditService } from './admin-audit.service';

export { STATUSES } from './filters';
export type { MessageQuery } from './filters';

@Injectable()
export class AdminMessagesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly repo: MessagesRepository,
    private readonly queues: QueueService,
    private readonly audit: AdminAuditService,
    private readonly events: EventLogger,
    private readonly crypto: BodyCrypto,
  ) {}

  async list(q: MessageQuery) {
    const page = Math.max(1, q.page ?? 1);
    const pageSize = Math.min(200, Math.max(1, q.pageSize ?? 50));
    const where = messageWhere(q);
    const sort = q.sort ?? 'createdAt';
    const order = q.order ?? 'desc';
    const [items, total] = await Promise.all([
      this.prisma.message.findMany({
        where,
        orderBy: sort === 'createdAt' ? { createdAt: order } : [{ [sort]: order }, { createdAt: 'desc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
        select: {
          id: true,
          status: true,
          deliveryMode: true,
          provider: true,
          source: true,
          to: true,
          cc: true,
          bcc: true,
          subject: true,
          rejectCode: true,
          attempts: true,
          deliveryOutcome: true,
          createdAt: true,
          sentAt: true,
          apiKey: { select: { id: true, name: true } },
        },
      }),
      this.prisma.message.count({ where }),
    ]);
    return { items, total, page, pageSize };
  }

  async get(id: string, opts: { includeBodies: boolean }) {
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw new GatewayError('MESSAGE_NOT_FOUND', `Message ${id} not found.`);
    const m = await this.prisma.message.findUnique({
      where: { id },
      include: {
        apiKey: { select: { id: true, name: true, mode: true } },
        attachments: { select: { id: true, filename: true, contentType: true, sizeBytes: true } },
        events: { orderBy: { at: 'asc' } },
      },
    });
    if (!m) throw new GatewayError('MESSAGE_NOT_FOUND', `Message ${id} not found.`);
    const { textBody: textEnc, htmlBody: htmlEnc, ...rest } = m;
    // decrypt only for callers allowed to see bodies
    const textBody = opts.includeBodies ? this.crypto.openText(textEnc) : null;
    const htmlBody = opts.includeBodies ? this.crypto.openText(htmlEnc) : null;
    return {
      ...rest,
      headers: {
        'X-Mail-Gateway-Key': m.apiKey.name,
        'X-Mail-Gateway-Message-Id': m.id,
        ...(m.headerMessageId ? { 'Message-ID': m.headerMessageId } : {}),
      },
      bodiesVisible: opts.includeBodies,
      textBody,
      htmlBody,
      hasHtml: !!htmlEnc,
      hasText: !!textEnc,
    };
  }

  async htmlBody(id: string): Promise<string | null> {
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw new GatewayError('MESSAGE_NOT_FOUND', `Message ${id} not found.`);
    const m = await this.prisma.message.findUnique({ where: { id }, select: { htmlBody: true } });
    if (!m) throw new GatewayError('MESSAGE_NOT_FOUND', `Message ${id} not found.`);
    return this.crypto.openText(m.htmlBody);
  }

  /** Encrypts bodies stored before encryption was enabled (CLI messages:encrypt-bodies). */
  async encryptLegacyBodies(batch = 500): Promise<{ messages: number; attachments: number }> {
    if (!this.crypto.enabled) throw new GatewayError('INVALID_STATE', 'APP_ENCRYPTION_KEY is not configured.');
    let messages = 0;
    let attachments = 0;
    for (;;) {
      const rows = await this.prisma.$queryRaw<Array<{ id: string; textBody: string | null; htmlBody: string | null }>>`
        SELECT id, text_body AS "textBody", html_body AS "htmlBody" FROM messages
        WHERE (text_body IS NOT NULL AND text_body NOT LIKE 'enc:v1:%') OR (html_body IS NOT NULL AND html_body NOT LIKE 'enc:v1:%')
        LIMIT ${batch}`;
      if (!rows.length) break;
      for (const r of rows) {
        await this.prisma.message.update({ where: { id: r.id }, data: { textBody: this.crypto.sealText(r.textBody), htmlBody: this.crypto.sealText(r.htmlBody) } });
        messages += 1;
      }
    }
    let after: string | undefined;
    for (;;) {
      const rows = await this.prisma.messageAttachment.findMany({
        where: { content: { not: null }, ...(after ? { id: { gt: after } } : {}) },
        orderBy: { id: 'asc' },
        select: { id: true, content: true },
        take: 100,
      });
      if (!rows.length) break;
      for (const r of rows) {
        if (r.content && !BodyCrypto.isSealedBytes(r.content)) {
          await this.prisma.messageAttachment.update({ where: { id: r.id }, data: { content: new Uint8Array(this.crypto.sealBytes(Buffer.from(r.content))) } });
          attachments += 1;
        }
      }
      after = rows[rows.length - 1].id;
    }
    return { messages, attachments };
  }

  async approve(id: string, actor: Actor) {
    const m = await this.repo.transition(id, ['pending_approval'], 'queued', {}, { by: actor.label });
    if (!m) throw new GatewayError('INVALID_STATE', `Message ${id} is not pending approval.`);
    await this.queues.enqueueDelivery(m.id);
    await this.audit.record(actor, { action: 'message.approve', targetType: 'message', targetId: id });
    this.events.emit('message_approved', { messageId: id, outcome: 'success', actor: actor.label });
    return { id, status: m.status };
  }

  async reject(id: string, reason: string | undefined, actor: Actor) {
    const r = (reason ?? '').slice(0, 1000) || 'Rejected by administrator';
    const m = await this.repo.transition(
      id,
      ['pending_approval'],
      'rejected',
      { rejectCode: 'REJECTED_BY_ADMIN', rejectReason: r },
      { by: actor.label, reason: r },
    );
    if (!m) throw new GatewayError('INVALID_STATE', `Message ${id} is not pending approval.`);
    await this.audit.record(actor, { action: 'message.reject', targetType: 'message', targetId: id, details: { reason: r } });
    this.events.emit('message_rejected_by_admin', { messageId: id, outcome: 'rejected', reason: 'REJECTED_BY_ADMIN', actor: actor.label });
    return { id, status: m.status };
  }

  async bulk(ids: string[], fn: (id: string) => Promise<unknown>) {
    const results: Array<{ id: string; ok: boolean; error?: string }> = [];
    for (const id of ids.slice(0, 500)) {
      try {
        await fn(id);
        results.push({ id, ok: true });
      } catch (e) {
        results.push({ id, ok: false, error: (e as Error).message });
      }
    }
    return { results };
  }

  pendingCount() {
    return this.prisma.message.count({ where: { status: 'pending_approval' } });
  }
}
