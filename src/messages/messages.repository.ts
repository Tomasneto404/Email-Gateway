// Authored by Tomás Neto (TN 2026)
import { Injectable } from '@nestjs/common';
import { BodyCrypto } from '../common/body-crypto';
import { hourBucket } from '../common/time';
import { PrismaService } from '../common/prisma.service';
import { Message, MessageStatus, Prisma } from '../generated/prisma/client';

type Tx = Prisma.TransactionClient;

export type MessageCreate = Omit<Prisma.MessageUncheckedCreateInput, 'attachments' | 'events'> & {
  status: MessageStatus;
  attachments?: Array<{ filename: string; contentType: string; sizeBytes: number; content: Buffer }>;
};

export interface MessageStatusView {
  id: string;
  status: MessageStatus;
  mode: string;
  provider: string | null;
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  attempts: number;
  lastError: string | null;
  rejectCode: string | null;
  rejectReason: string | null;
  deliveryOutcome: string | null;
  createdAt: string;
  updatedAt: string;
  sentAt: string | null;
}

export function toStatusView(m: Message): MessageStatusView {
  return {
    id: m.id,
    status: m.status,
    mode: m.deliveryMode,
    provider: m.provider,
    to: m.to,
    cc: m.cc,
    bcc: m.bcc,
    subject: m.subject,
    attempts: m.attempts,
    lastError: m.lastError,
    rejectCode: m.rejectCode,
    rejectReason: m.rejectReason,
    deliveryOutcome: m.deliveryOutcome,
    createdAt: m.createdAt.toISOString(),
    updatedAt: m.updatedAt.toISOString(),
    sentAt: m.sentAt?.toISOString() ?? null,
  };
}

/**
 * All message writes go through here so that the status timeline (message_events)
 * and the hourly roll-up (message_stats_hourly) stay consistent with the row.
 */
@Injectable()
export class MessagesRepository {
  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: BodyCrypto,
  ) {}

  async bumpStats(tx: Tx | PrismaService, apiKeyId: string, status: string, reason = '', at = new Date()) {
    await tx.$executeRaw`
      INSERT INTO message_stats_hourly (bucket, api_key_id, status, reason, count)
      VALUES (${hourBucket(at)}, ${apiKeyId}::uuid, ${status}, ${reason}, 1)
      ON CONFLICT (bucket, api_key_id, status, reason)
      DO UPDATE SET count = message_stats_hourly.count + 1`;
  }

  /** Bodies and attachment contents are encrypted at rest here (see BodyCrypto). */
  async create(data: MessageCreate): Promise<Message> {
    const { attachments, ...row } = data;
    return this.prisma.$transaction(async (tx) => {
      const msg = await tx.message.create({
        data: {
          ...row,
          textBody: this.crypto.sealText(row.textBody),
          htmlBody: this.crypto.sealText(row.htmlBody),
          ...(attachments?.length
            ? { attachments: { create: attachments.map((a) => ({ ...a, content: new Uint8Array(this.crypto.sealBytes(a.content)) })) } }
            : {}),
        },
      });
      await tx.messageEvent.create({
        data: {
          messageId: msg.id,
          type: 'status',
          toStatus: msg.status,
          detail: msg.rejectCode ? { code: msg.rejectCode, reason: msg.rejectReason } : undefined,
        },
      });
      await this.bumpStats(tx, msg.apiKeyId, msg.status, msg.status === 'rejected' ? (msg.rejectCode ?? '') : '');
      // 'accepted' = volume metric (each accepted message counted exactly once).
      if (msg.status !== 'rejected') await this.bumpStats(tx, msg.apiKeyId, 'accepted');
      return msg;
    });
  }

  /**
   * Compare-and-set status transition. Returns the updated row, or null if the message
   * was not in one of the expected `from` states (e.g. already processed).
   */
  async transition(
    id: string,
    from: MessageStatus[],
    to: MessageStatus,
    patch: Prisma.MessageUncheckedUpdateManyInput = {},
    detail?: Record<string, unknown>,
  ): Promise<Message | null> {
    return this.prisma.$transaction(async (tx) => {
      const current = await tx.message.findUnique({ where: { id }, select: { status: true, apiKeyId: true } });
      if (!current) return null;
      const res = await tx.message.updateMany({ where: { id, status: { in: from } }, data: { ...patch, status: to } });
      if (res.count !== 1) return null;
      await tx.messageEvent.create({
        data: { messageId: id, type: 'status', fromStatus: current.status, toStatus: to, detail: detail as Prisma.InputJsonValue | undefined },
      });
      await this.bumpStats(tx, current.apiKeyId, to, to === 'rejected' ? String(patch.rejectCode ?? '') : '');
      return tx.message.findUnique({ where: { id } });
    });
  }

  async addEvent(messageId: string, type: string, detail: Record<string, unknown>) {
    await this.prisma.messageEvent.create({ data: { messageId, type, detail: detail as Prisma.InputJsonValue } });
  }

  async update(id: string, data: Prisma.MessageUncheckedUpdateInput) {
    return this.prisma.message.update({ where: { id }, data });
  }

  findForDelivery(id: string) {
    return this.prisma.message.findUnique({
      where: { id },
      include: { attachments: true, apiKey: { select: { name: true } } },
    });
  }

  findById(id: string) {
    if (!/^[0-9a-f-]{36}$/i.test(id)) return Promise.resolve(null);
    return this.prisma.message.findUnique({ where: { id } });
  }
}
