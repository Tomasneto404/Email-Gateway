// Authored by Tomás Neto (TN 2026)
import { Inject, Injectable } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { APP_CONFIG, AppConfig } from '../config/config';
import { GatewayError } from '../common/errors';
import { PrismaService } from '../common/prisma.service';
import { Actor, AdminAuditService } from '../admin/admin-audit.service';
import { ApiKey, Prisma } from '../generated/prisma/client';
import { CreateKeyDto, PolicyFieldsDto, UpdateKeyDto } from './keys.dto';
import { displayPrefix, generateApiKey, hashApiKey, safeEqual } from './key-format';

export interface PolicyView {
  id: string;
  name: string;
  description: string;
  keyPrefix: string;
  mode: ApiKey['mode'];
  enabled: boolean;
  fromAddress: string;
  fromName: string | null;
  allowReplyTo: boolean;
  allowedRecipients: string[];
  maxRecipientsPerMessage: number;
  maxMessageBytes: number;
  quotaPerHour: number;
  quotaPerDay: number;
  attachmentsAllowed: boolean;
  maxAttachmentBytes: number;
  liveProvider: ApiKey['liveProvider'];
  /** true when the key prefix (mk_sbx_/mk_live_) no longer matches the mode: rotate recommended. */
  prefixStale: boolean;
  lastUsedAt: string | null;
  rotatedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export function toPolicyView(k: ApiKey): PolicyView {
  const issuedLive = k.keyPrefix.startsWith('mk_live_');
  return {
    id: k.id,
    name: k.name,
    description: k.description,
    keyPrefix: k.keyPrefix,
    mode: k.mode,
    enabled: k.enabled,
    fromAddress: k.fromAddress,
    fromName: k.fromName,
    allowReplyTo: k.allowReplyTo,
    allowedRecipients: k.allowedRecipients,
    maxRecipientsPerMessage: k.maxRecipientsPerMessage,
    maxMessageBytes: k.maxMessageBytes,
    quotaPerHour: k.quotaPerHour,
    quotaPerDay: k.quotaPerDay,
    attachmentsAllowed: k.attachmentsAllowed,
    maxAttachmentBytes: k.maxAttachmentBytes,
    liveProvider: k.liveProvider,
    prefixStale: issuedLive !== (k.mode !== 'sandbox'),
    lastUsedAt: k.lastUsedAt?.toISOString() ?? null,
    rotatedAt: k.rotatedAt?.toISOString() ?? null,
    createdAt: k.createdAt.toISOString(),
    updatedAt: k.updatedAt.toISOString(),
  };
}

export async function validateDto<T extends object>(cls: new () => T, body: unknown): Promise<T> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new GatewayError('VALIDATION_FAILED', 'Request body must be a JSON object.');
  }
  const inst = plainToInstance(cls, body);
  const errors = await validate(inst, { whitelist: true, forbidNonWhitelisted: true });
  if (errors.length) {
    const problems = errors.flatMap((e) =>
      e.constraints ? Object.values(e.constraints) : (e.children ?? []).flatMap((c) => Object.values(c.constraints ?? {}).map((m) => `${e.property}: ${m}`)),
    );
    throw new GatewayError('VALIDATION_FAILED', `Invalid request: ${problems.join('; ')}`, { problems });
  }
  return inst;
}

export interface ListKeysQuery {
  q?: string;
  mode?: ApiKey['mode'];
  enabled?: boolean;
  page?: number;
  pageSize?: number;
  sort?: 'name' | 'createdAt' | 'lastUsedAt';
  order?: 'asc' | 'desc';
}

@Injectable()
export class KeysService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AdminAuditService,
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
  ) {}

  /** Bearer secret → active (non-deleted) key, or null. */
  async authenticate(secret: string): Promise<ApiKey | null> {
    if (!secret || secret.length > 200) return null;
    const hash = hashApiKey(secret);
    const key = await this.prisma.apiKey.findUnique({ where: { keyHash: hash } });
    if (!key || key.deletedAt) return null;
    if (!safeEqual(hash, key.keyHash)) return null;
    // Throttled last-used update (at most once per minute).
    if (!key.lastUsedAt || Date.now() - key.lastUsedAt.getTime() > 60_000) {
      void this.prisma.apiKey.update({ where: { id: key.id }, data: { lastUsedAt: new Date() } }).catch(() => undefined);
    }
    return key;
  }

  async create(body: unknown, actor: Actor): Promise<{ key: PolicyView; secret: string }> {
    const dto = await validateDto(CreateKeyDto, body);
    if (!dto.fromAddress) throw new GatewayError('VALIDATION_FAILED', 'fromAddress is required when creating a key.');
    const exists = await this.prisma.apiKey.findUnique({ where: { name: dto.name } });
    if (exists) throw new GatewayError('CONFLICT', `A key named "${dto.name}" already exists.`);
    const mode = dto.mode ?? 'sandbox';
    const secret = generateApiKey(mode);
    const key = await this.prisma.apiKey.create({
      data: {
        name: dto.name,
        description: dto.description ?? '',
        keyHash: hashApiKey(secret),
        keyPrefix: displayPrefix(secret),
        mode,
        enabled: dto.enabled ?? true,
        fromAddress: dto.fromAddress,
        fromName: dto.fromName ?? null,
        allowReplyTo: dto.allowReplyTo ?? false,
        allowedRecipients: dedupe(dto.allowedRecipients ?? []),
        maxRecipientsPerMessage: dto.maxRecipientsPerMessage ?? this.cfg.DEFAULT_MAX_RECIPIENTS,
        maxMessageBytes: dto.maxMessageBytes ?? this.cfg.DEFAULT_MAX_MESSAGE_BYTES,
        quotaPerHour: dto.quotaPerHour ?? this.cfg.DEFAULT_QUOTA_PER_HOUR,
        quotaPerDay: dto.quotaPerDay ?? this.cfg.DEFAULT_QUOTA_PER_DAY,
        attachmentsAllowed: dto.attachmentsAllowed ?? false,
        maxAttachmentBytes: dto.maxAttachmentBytes ?? this.cfg.DEFAULT_MAX_ATTACHMENT_BYTES,
        liveProvider: dto.liveProvider ?? null,
      },
    });
    await this.audit.record(actor, {
      action: 'key.create',
      targetType: 'api_key',
      targetId: key.id,
      details: { name: key.name, mode: key.mode },
    });
    return { key: toPolicyView(key), secret };
  }

  async update(id: string, body: unknown, actor: Actor): Promise<PolicyView> {
    const dto = await validateDto(UpdateKeyDto, body);
    const before = await this.getActive(id);
    const data: Prisma.ApiKeyUpdateInput = {};
    const changes: Record<string, { from: unknown; to: unknown }> = {};
    for (const field of Object.keys(dto) as Array<keyof PolicyFieldsDto>) {
      const v = dto[field];
      if (v === undefined) continue;
      const next = field === 'allowedRecipients' ? dedupe(v as string[]) : v;
      const prev = before[field as keyof ApiKey];
      if (JSON.stringify(prev) === JSON.stringify(next)) continue;
      (data as Record<string, unknown>)[field] = next;
      changes[field] = { from: prev, to: next };
    }
    if (!Object.keys(changes).length) return toPolicyView(before);
    const key = await this.prisma.apiKey.update({ where: { id }, data });
    const action = changes.mode
      ? changes.mode.to === 'live'
        ? 'key.promote_live'
        : 'key.mode_change'
      : changes.enabled
        ? key.enabled
          ? 'key.enable'
          : 'key.disable'
        : 'key.policy_update';
    await this.audit.record(actor, { action, targetType: 'api_key', targetId: id, details: { name: key.name, changes } });
    return toPolicyView(key);
  }

  async setEnabled(id: string, enabled: boolean, actor: Actor): Promise<PolicyView> {
    return this.update(id, { enabled }, actor);
  }

  async rotate(id: string, actor: Actor): Promise<{ key: PolicyView; secret: string }> {
    const before = await this.getActive(id);
    const secret = generateApiKey(before.mode);
    const key = await this.prisma.apiKey.update({
      where: { id },
      data: { keyHash: hashApiKey(secret), keyPrefix: displayPrefix(secret), rotatedAt: new Date() },
    });
    await this.audit.record(actor, { action: 'key.rotate', targetType: 'api_key', targetId: id, details: { name: key.name } });
    return { key: toPolicyView(key), secret };
  }

  async remove(id: string, actor: Actor): Promise<void> {
    const k = await this.getActive(id);
    await this.prisma.apiKey.update({
      where: { id },
      data: {
        deletedAt: new Date(),
        enabled: false,
        name: `${k.name}~deleted~${id.slice(-8)}`,
        keyHash: `deleted:${id}`,
      },
    });
    await this.audit.record(actor, { action: 'key.delete', targetType: 'api_key', targetId: id, details: { name: k.name } });
  }

  async getActive(id: string): Promise<ApiKey> {
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw new GatewayError('KEY_NOT_FOUND', `API key ${id} not found.`);
    const k = await this.prisma.apiKey.findUnique({ where: { id } });
    if (!k || k.deletedAt) throw new GatewayError('KEY_NOT_FOUND', `API key ${id} not found.`);
    return k;
  }

  async findByName(name: string): Promise<ApiKey> {
    const k = await this.prisma.apiKey.findUnique({ where: { name } });
    if (!k || k.deletedAt) throw new GatewayError('KEY_NOT_FOUND', `API key "${name}" not found.`);
    return k;
  }

  async list(q: ListKeysQuery = {}) {
    const page = Math.max(1, q.page ?? 1);
    const pageSize = Math.min(200, Math.max(1, q.pageSize ?? 50));
    const where: Prisma.ApiKeyWhereInput = {
      deletedAt: null,
      ...(q.q ? { OR: [{ name: { contains: q.q, mode: 'insensitive' } }, { description: { contains: q.q, mode: 'insensitive' } }] } : {}),
      ...(q.mode ? { mode: q.mode } : {}),
      ...(q.enabled !== undefined ? { enabled: q.enabled } : {}),
    };
    const sort = q.sort ?? 'name';
    const order = q.order ?? (sort === 'name' ? 'asc' : 'desc');
    const [items, total] = await Promise.all([
      this.prisma.apiKey.findMany({
        where,
        orderBy: sort === 'lastUsedAt' ? { lastUsedAt: { sort: order, nulls: 'last' } } : { [sort]: order },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.apiKey.count({ where }),
    ]);
    return { items: items.map(toPolicyView), total, page, pageSize };
  }
}

function dedupe(a: string[]): string[] {
  return [...new Set(a.map((s) => s.trim().toLowerCase()))];
}
