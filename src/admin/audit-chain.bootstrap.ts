// Authored by Tomás Neto (TN 2026)
import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { AuditChainService } from './audit-chain.service';

/** On API start: hash activity-log rows that predate the chain (first start after the migration). */
@Injectable()
export class AuditChainBootstrap implements OnApplicationBootstrap {
  constructor(private readonly chain: AuditChainService) {}

  async onApplicationBootstrap() {
    const n = await this.chain.backfill();
    if (n) new Logger('AuditChain').log(`chained ${n} existing activity-log rows`);
  }
}
