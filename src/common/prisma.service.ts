// Authored by Tomás Neto (TN 2026)
import { Inject, Injectable, OnModuleDestroy } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client';
import { APP_CONFIG, AppConfig } from '../config/config';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleDestroy {
  constructor(@Inject(APP_CONFIG) cfg: AppConfig) {
    super({ adapter: new PrismaPg({ connectionString: cfg.DATABASE_URL, max: 10 }) });
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }
}
