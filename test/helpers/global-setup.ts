import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer, StartedRedisContainer } from '@testcontainers/redis';
import { execFileSync } from 'node:child_process';
import { GenericContainer, StartedTestContainer, Wait } from 'testcontainers';
import type { TestProject } from 'vitest/node';

export const MAILPIT_IMAGE = 'axllent/mailpit:v1.33.1';

declare module 'vitest' {
  export interface ProvidedContext {
    stack: {
      DATABASE_URL: string;
      REDIS_URL: string;
      /** Mailpit used as the sandbox target */
      SANDBOX_SMTP_HOST: string;
      SANDBOX_SMTP_PORT: string;
      SANDBOX_API: string;
      /** Second Mailpit standing in for the existing "live" SMTP */
      LIVE_SMTP_HOST: string;
      LIVE_SMTP_PORT: string;
      LIVE_API: string;
    };
  }
}

function mailpit() {
  return new GenericContainer(MAILPIT_IMAGE)
    .withExposedPorts(1025, 8025)
    .withEnvironment({ MP_SMTP_AUTH_ACCEPT_ANY: '1', MP_SMTP_AUTH_ALLOW_INSECURE: '1', MP_MAX_MESSAGES: '5000' })
    .withWaitStrategy(Wait.forHttp('/livez', 8025))
    .start();
}

export default async function setup(project: TestProject) {
  const [pg, redis, sandbox, live] = (await Promise.all([
    new PostgreSqlContainer('postgres:17-alpine').start(),
    new RedisContainer('redis:7-alpine').start(),
    mailpit(),
    mailpit(),
  ])) as [StartedPostgreSqlContainer, StartedRedisContainer, StartedTestContainer, StartedTestContainer];

  const DATABASE_URL = pg.getConnectionUri();
  execFileSync('npx', ['prisma', 'migrate', 'deploy'], { env: { ...process.env, DATABASE_URL }, stdio: 'pipe' });

  project.provide('stack', {
    DATABASE_URL,
    REDIS_URL: redis.getConnectionUrl(),
    SANDBOX_SMTP_HOST: sandbox.getHost(),
    SANDBOX_SMTP_PORT: String(sandbox.getMappedPort(1025)),
    SANDBOX_API: `http://${sandbox.getHost()}:${sandbox.getMappedPort(8025)}`,
    LIVE_SMTP_HOST: live.getHost(),
    LIVE_SMTP_PORT: String(live.getMappedPort(1025)),
    LIVE_API: `http://${live.getHost()}:${live.getMappedPort(8025)}`,
  });

  return async () => {
    await Promise.allSettled([pg.stop(), redis.stop(), sandbox.stop(), live.stop()]);
  };
}
