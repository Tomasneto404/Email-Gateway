import { Injectable } from '@nestjs/common';
import { EventLogger } from '../common/event-logger';
import { PrismaService } from '../common/prisma.service';
import { Prisma } from '../generated/prisma/client';

export type ActorType = 'user' | 'token' | 'cli' | 'system';
export interface Actor {
  type: ActorType;
  id?: string;
  label: string;
  ip?: string;
  role?: 'admin' | 'viewer';
  canViewBodies?: boolean;
}

export const SYSTEM_ACTOR: Actor = { type: 'system', label: 'system' };
export const CLI_ACTOR: Actor = { type: 'cli', label: 'cli' };

export interface AuditEntry {
  action: string;
  targetType?: string;
  targetId?: string;
  details?: Record<string, unknown>;
  outcome?: 'success' | 'failure';
}

/** Writes every admin action to `admin_audit` and emits a structured `admin_action` event. */
@Injectable()
export class AdminAuditService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly events: EventLogger,
  ) {}

  async record(actor: Actor, entry: AuditEntry): Promise<void> {
    const outcome = entry.outcome ?? 'success';
    await this.prisma.adminAudit.create({
      data: {
        actorType: actor.type,
        actorId: actor.id ?? null,
        actorLabel: actor.label,
        action: entry.action,
        targetType: entry.targetType ?? null,
        targetId: entry.targetId ?? null,
        details: (entry.details ?? undefined) as Prisma.InputJsonValue | undefined,
        ip: actor.ip ?? null,
        outcome,
      },
    });
    this.events.emit('admin_action', {
      action: entry.action,
      actorType: actor.type,
      actor: actor.label,
      targetType: entry.targetType,
      targetId: entry.targetId,
      outcome: outcome === 'success' ? 'success' : 'failure',
      ip: actor.ip,
    });
  }
}
