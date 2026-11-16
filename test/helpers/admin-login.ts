import request from 'supertest';
import { CLI_ACTOR } from '../../src/admin/admin-audit.service';
import { SecretBox } from '../../src/auth/crypto';
import { UsersService } from '../../src/auth/users.service';
import { totp, totpStep } from '../../src/auth/totp';
import { PrismaService } from '../../src/common/prisma.service';
import { Stack, uname } from './stack';

export const PASSWORD = 'correct horse battery staple';

export interface LoggedIn {
  agent: ReturnType<typeof request.agent>;
  csrf: string;
  email: string;
  userId: string;
  /** headers needed for state-changing requests */
  h: Record<string, string>;
}

export async function createUser(s: Stack, role: 'admin' | 'viewer', canViewBodies = false) {
  const email = `${uname(role)}@admins.test`;
  const u = await s.api.get(UsersService).createLocal({ email, role, canViewBodies, password: PASSWORD }, CLI_ACTOR);
  return { email, id: u.id };
}

/** Next TOTP code that is strictly newer than the last accepted step (avoids replay rejection in fast tests). */
export async function nextCode(s: Stack, userId: string): Promise<string> {
  const u = await s.api.get(PrismaService).adminUser.findUniqueOrThrow({ where: { id: userId } });
  const secret = s.api.get(SecretBox).open(u.totpSecretEnc!);
  const step = totpStep();
  const target = u.totpLastStep !== null && u.totpLastStep >= step ? u.totpLastStep + 1 : step;
  return totp(secret, target * 30_000);
}

export async function login(s: Stack, role: 'admin' | 'viewer', canViewBodies = false): Promise<LoggedIn> {
  const { email, id } = await createUser(s, role, canViewBodies);
  const agent = request.agent(s.baseUrl);
  const origin = { Origin: s.baseUrl };
  const l = await agent.post('/admin/auth/login').set(origin).send({ email, password: PASSWORD });
  if (l.status !== 200) throw new Error(`login ${l.status} ${JSON.stringify(l.body)}`);
  if (l.body.next === 'totp_enroll') await agent.post('/admin/auth/totp/enroll').set(origin).send({});
  const v = await agent.post('/admin/auth/totp/verify').set(origin).send({ code: await nextCode(s, id) });
  if (v.status !== 200) throw new Error(`verify ${v.status} ${JSON.stringify(v.body)}`);
  return { agent, csrf: v.body.csrfToken, email, userId: id, h: { Origin: s.baseUrl, 'X-CSRF-Token': v.body.csrfToken } };
}
