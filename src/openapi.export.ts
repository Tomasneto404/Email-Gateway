// Authored by Tomás Neto (TN 2026)
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import pino from 'pino';
import { ApiModule } from './api.module';
import { buildConfig } from './config/config';
import { buildOpenApiDocument, stableStringify } from './openapi';

/** Writes openapi.json without touching Postgres/Redis (Nest preview mode: no providers instantiated). */
export async function exportOpenApi(): Promise<string> {
  const cfg = buildConfig({ DATABASE_URL: 'postgresql://unused/unused', REDIS_URL: 'redis://unused:6379' });
  const app = await NestFactory.create(ApiModule.forRoot({ cfg, logger: pino({ level: 'silent' }), opsServer: false }), {
    preview: true,
    logger: false,
    abortOnError: false,
  });
  const doc = stableStringify(buildOpenApiDocument(app));
  await app.close();
  return doc;
}

if (require.main === module) {
  exportOpenApi()
    .then((doc) => {
      const out = resolve(process.argv[2] ?? 'openapi.json');
      writeFileSync(out, doc);
      process.stdout.write(`wrote ${out}\n`);
      process.exit(0);
    })
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}
