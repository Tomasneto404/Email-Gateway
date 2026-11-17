import request from 'supertest';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { PASSWORD, login } from '../helpers/admin-login';
import { Stack, mailpit, resetState, startStack, uname, waitFor } from '../helpers/stack';

let s: Stack;
beforeAll(async () => {
  s = await startStack({ SYSTEM_MAIL_FROM: 'noreply@gateway.test', SYSTEM_MAIL_FROM_NAME: 'Mail Gateway' });
  await resetState(s);
});
afterAll(async () => s?.close());

async function fetchMail(to: string) {
  const live = inject('stack').LIVE_API;
  const found = await waitFor(async () => (await mailpit.search(live, `to:"${to}"`)).messages[0]);
  const r = await fetch(`${live}/api/v1/message/${found.ID}`);
  return (await r.json()) as { Subject: string; Text: string; HTML: string; From: { Address: string; Name: string } };
}

describe('invites by email', () => {
  it('invite is emailed through the live provider and the link works', async () => {
    const admin = await login(s, 'admin');
    const email = `${uname('invitee')}@example.com`;
    const r = await admin.agent.post('/admin/users').set(admin.h).send({ email, roleIds: ['Viewer'] });
    expect(r.status).toBe(201);
    expect(r.body.emailed).toBe(true);

    const mail = await fetchMail(email);
    expect(mail.Subject).toBe("You've been invited to mail-gateway");
    expect(mail.From).toMatchObject({ Address: 'noreply@gateway.test', Name: 'Mail Gateway' });
    const link = /https?:\/\/\S+\/ui\/invite\/[A-Za-z0-9_-]+/.exec(mail.Text)?.[0];
    expect(link).toBeDefined();
    expect(link!.startsWith(s.baseUrl)).toBe(true); // absolute link from the admin's origin
    expect(new URL(link!).pathname).toBe(r.body.invitePath);
    expect(mail.HTML).toContain('Set your password');

    const token = link!.split('/').pop()!;
    expect((await request(s.baseUrl).post(`/admin/auth/invite/${token}`).set({ Origin: s.baseUrl }).send({ password: PASSWORD })).status).toBe(200);
    const l = await request(s.baseUrl).post('/admin/auth/login').set({ Origin: s.baseUrl }).send({ email, password: PASSWORD });
    expect(l.body.next).toBe('done');

    // the invite link is a credential: never in logs
    await waitFor(async () => s.logs.events('system_mail_sent').some((e) => e.to === email));
    expect(s.logs.raw).not.toContain(token);
    const audit = await s.prisma.adminAudit.findFirst({ where: { action: 'user.invite', details: { path: ['email'], equals: email } } });
    expect(audit?.details).toMatchObject({ emailed: true });
  });

  it('reset access emails a new link', async () => {
    const admin = await login(s, 'admin');
    const target = await login(s, 'viewer');
    const r = await admin.agent.post(`/admin/users/${target.userId}/reset-access`).set(admin.h).send({});
    expect(r.body.emailed).toBe(true);
    const mail = await fetchMail(target.email);
    expect(mail.Subject).toBe('Reset your mail-gateway access');
  });
});

describe('without system mail configured', () => {
  it('returns the link only (emailed=false)', async () => {
    const plain = await startStack({}, { worker: false });
    try {
      const admin = await login(plain, 'admin');
      const r = await admin.agent.post('/admin/users').set(admin.h).send({ email: `${uname('nomail')}@example.com`, roleIds: ['Viewer'] });
      expect(r.body).toMatchObject({ emailed: false, invitePath: expect.stringMatching(/^\/ui\/invite\//) });
    } finally {
      await plain.close();
    }
  });
});
