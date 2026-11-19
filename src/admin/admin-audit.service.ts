// Authored by Tomás Neto (TN 2026)
import { Injectable } from '@nestjs/common';
import { EventLogger } from '../common/event-logger';
import { Prisma } from '../generated/prisma/client';
import { AuditChainService } from './audit-chain.service';

export type ActorType = 'user' | 'token' | 'cli' | 'system';
export interface Actor {
  type: ActorType;
  id?: string;
  label: string;
  ip?: string;
  /** effective RBAC permissions (see src/auth/permissions.ts) */
  permissions?: string[];
}

export const SYSTEM_ACTOR: Actor = { type: 'system', label: 'system', permissions: ['*'] };
/** The CLI runs with shell access to the deployment, i.e. full control. */
export const CLI_ACTOR: Actor = { type: 'cli', label: 'cli', permissions: ['*'] };

export interface AuditEntry {
  action: string;
  targetType?: string;
  targetId?: string;
  details?: Record<string, unknown>;
  outcome?: 'success' | 'failure';
}

/**
 * Writes every admin action to `admin_audit` (appended to the tamper-evident hash chain) and emits a
 * structured `admin_action` event.
 */
@Injectable()
export class AdminAuditService {
  constructor(
    private readonly chain: AuditChainService,
    private readonly events: EventLogger,
  ) {}

  async record(actor: Actor, entry: AuditEntry): Promise<void> {
    const outcome = entry.outcome ?? 'success';
    await this.chain.append({
      actorType: actor.type,
      actorId: actor.id ?? null,
      actorLabel: actor.label,
      action: entry.action,
      targetType: entry.targetType ?? null,
      targetId: entry.targetId ?? null,
      details: (entry.details ?? undefined) as Prisma.InputJsonValue | undefined,
      ip: actor.ip ?? null,
      outcome,
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
