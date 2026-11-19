// Authored by Tomás Neto (TN 2026)
import { Inject, Injectable } from '@nestjs/common';
import { createHash, createHmac } from 'node:crypto';
import { APP_CONFIG, AppConfig } from '../config/config';
import { deriveKey } from '../common/body-crypto';
import { PrismaService } from '../common/prisma.service';
import { AdminAudit, Prisma } from '../generated/prisma/client';

type Tx = Prisma.TransactionClient;
/** Serializes every write to the chain (pg advisory lock id). */
const CHAIN_LOCK = 7302601;

export type AuditRowInput = Omit<Prisma.AdminAuditUncheckedCreateInput, 'id' | 'seq' | 'prevHash' | 'hash' | 'at'>;
type HashedFields = Pick<AdminAudit, 'seq' | 'at' | 'actorType' | 'actorId' | 'actorLabel' | 'action' | 'targetType' | 'targetId' | 'details' | 'ip' | 'outcome'>;

export interface ChainVerification {
  ok: boolean;
  checked: number;
  /** last row of the chain: record it outside the gateway to also detect truncation of the newest rows */
  headSeq: string | null;
  headHash: string | null;
  /** where the chain starts after retention removed older rows */
  anchorSeq: string | null;
  brokenAtSeq: string | null;
  reason: string | null;
}

/** JSON with object keys sorted at every level (JSONB does not keep key order). */
export function canonicalJson(v: unknown): string {
  if (v === null || v === undefined) return 'null';
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o)
      .filter((k) => o[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(v);
}

/**
 * Tamper-evident activity log. Each row stores the hash of the previous row and its own hash over
 * (seq, fields, prevHash). With APP_ENCRYPTION_KEY the hash is an HMAC ("hmac:"), so someone with
 * write access to the database alone cannot rebuild a valid chain after editing or deleting rows.
 * Without the key it is a plain SHA-256 chain ("sha256:"), which still detects accidental edits.
 */
@Injectable()
export class AuditChainService {
  private readonly key: Buffer | null;

  constructor(
    private readonly prisma: PrismaService,
    @Inject(APP_CONFIG) cfg: AppConfig,
  ) {
    this.key = cfg.APP_ENCRYPTION_KEY ? deriveKey(cfg.APP_ENCRYPTION_KEY, 'audit-chain') : null;
  }

  digest(row: HashedFields, prevHash: string | null, algo: 'hmac' | 'sha256' = this.key ? 'hmac' : 'sha256'): string {
    const payload = canonicalJson([
      String(row.seq),
      row.at.toISOString(),
      row.actorType,
      row.actorId,
      row.actorLabel,
      row.action,
      row.targetType,
      row.targetId,
      row.details ?? null,
      row.ip,
      row.outcome,
      prevHash,
    ]);
    if (algo === 'hmac') {
      if (!this.key) throw new Error('hmac audit rows need APP_ENCRYPTION_KEY');
      return `hmac:${createHmac('sha256', this.key).update(payload).digest('hex')}`;
    }
    return `sha256:${createHash('sha256').update(payload).digest('hex')}`;
  }

  /** Appends one row to the chain. */
  async append(data: AuditRowInput): Promise<AdminAudit> {
    return this.prisma.$transaction(async (tx) => {
      await this.lock(tx);
      await this.backfillTx(tx);
      const prev = await this.headHash(tx);
      const row = await tx.adminAudit.create({ data: { ...data, prevHash: prev } });
      return tx.adminAudit.update({ where: { id: row.id }, data: { hash: this.digest(row, prev) } });
    });
  }

  /** Hashes rows written before the chain existed (migration) or by tools that bypass the service. */
  async backfill(): Promise<number> {
    return this.prisma.$transaction(async (tx) => {
      await this.lock(tx);
      return this.backfillTx(tx);
    }, { timeout: 120_000 });
  }

  /**
   * Retention: removes rows older than `cutoff` and moves the chain anchor to the last removed row,
   * so verification still starts from a known hash.
   */
  async prune(cutoff: Date): Promise<number> {
    return this.prisma.$transaction(async (tx) => {
      await this.lock(tx);
      await this.backfillTx(tx);
      const last = await tx.adminAudit.findFirst({ where: { at: { lt: cutoff } }, orderBy: { seq: 'desc' }, select: { seq: true, hash: true } });
      if (!last) return 0;
      await tx.auditChainState.upsert({
        where: { id: 1 },
        create: { id: 1, anchorSeq: last.seq, anchorHash: last.hash },
        update: { anchorSeq: last.seq, anchorHash: last.hash },
      });
      const res = await tx.adminAudit.deleteMany({ where: { seq: { lte: last.seq } } });
      return res.count;
    }, { timeout: 120_000 });
  }

  async verify(): Promise<ChainVerification> {
    const state = await this.prisma.auditChainState.findUnique({ where: { id: 1 } });
    let expectedPrev: string | null = state?.anchorHash ?? null;
    let checked = 0;
    let seenHmac = false;
    let head: { seq: bigint; hash: string | null } | null = null;
    let after: bigint | undefined;
    const result = (ok: boolean, brokenAt: bigint | null, reason: string | null): ChainVerification => ({
      ok,
      checked,
      headSeq: head ? String(head.seq) : null,
      headHash: head?.hash ?? null,
      anchorSeq: state?.anchorSeq != null ? String(state.anchorSeq) : null,
      brokenAtSeq: brokenAt !== null ? String(brokenAt) : null,
      reason,
    });
    for (;;) {
      const rows = await this.prisma.adminAudit.findMany({ where: after !== undefined ? { seq: { gt: after } } : {}, orderBy: { seq: 'asc' }, take: 1000 });
      if (!rows.length) break;
      for (const r of rows) {
        checked += 1;
        head = { seq: r.seq, hash: r.hash };
        if (!r.hash) return result(false, r.seq, 'row has no hash (written outside the gateway?)');
        if (r.prevHash !== expectedPrev) return result(false, r.seq, 'link to the previous row is broken: a row was deleted, inserted or reordered');
        const algo = r.hash.startsWith('hmac:') ? 'hmac' : 'sha256';
        if (algo === 'sha256' && seenHmac) return result(false, r.seq, 'unkeyed hash after keyed rows: the row was rewritten without the gateway key');
        if (algo === 'hmac') {
          if (!this.key) return result(false, r.seq, 'keyed hash but APP_ENCRYPTION_KEY is not configured here');
          seenHmac = true;
        }
        if (this.digest(r, r.prevHash, algo) !== r.hash) return result(false, r.seq, 'row content does not match its hash: the row was modified');
        expectedPrev = r.hash;
      }
      after = rows[rows.length - 1].seq;
    }
    return result(true, null, null);
  }

  private async lock(tx: Tx) {
    // the function returns void, which $queryRaw cannot deserialize
    await tx.$queryRaw`SELECT 1 AS locked FROM pg_advisory_xact_lock(${CHAIN_LOCK}::bigint)`;
  }

  private async headHash(tx: Tx): Promise<string | null> {
    const last = await tx.adminAudit.findFirst({ orderBy: { seq: 'desc' }, select: { hash: true } });
    if (last) return last.hash;
    const st = await tx.auditChainState.findUnique({ where: { id: 1 } });
    return st?.anchorHash ?? null;
  }

  private async backfillTx(tx: Tx): Promise<number> {
    let done = 0;
    for (;;) {
      const rows = await tx.adminAudit.findMany({ where: { hash: null }, orderBy: { seq: 'asc' }, take: 500 });
      if (!rows.length) return done;
      const before = await tx.adminAudit.findFirst({ where: { seq: { lt: rows[0].seq } }, orderBy: { seq: 'desc' }, select: { hash: true } });
      let prev = before ? before.hash : ((await tx.auditChainState.findUnique({ where: { id: 1 } }))?.anchorHash ?? null);
      for (const r of rows) {
        const hash = this.digest(r, prev);
        await tx.adminAudit.update({ where: { id: r.id }, data: { prevHash: prev, hash } });
        prev = hash;
        done += 1;
      }
    }
  }
}
