// Authored by Tomás Neto (TN 2026)
import { expect, test, type Page } from '@playwright/test';
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const CLI = process.env.MG_CLI ?? 'docker compose exec -T api node dist/cli.js';
const ROOT = new URL('../..', import.meta.url).pathname;
const run = Date.now().toString(36);
const ADMIN = `export-admin-${run}@admins.test`;
const PASSWORD = 'export correct horse battery staple';

test.beforeAll(() => {
  execSync(`${CLI} users:create --email ${ADMIN} --role Admin --password-stdin`, { cwd: ROOT, input: PASSWORD, stdio: ['pipe', 'pipe', 'inherit'] });
});

async function signIn(page: Page) {
  await page.goto('/ui/login');
  await page.getByLabel('Email').fill(ADMIN);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByTestId('current-user')).toHaveText(ADMIN);
}

async function download(page: Page, click: () => Promise<void>) {
  const [dl] = await Promise.all([page.waitForEvent('download'), click()]);
  return { name: dl.suggestedFilename(), text: readFileSync((await dl.path())!, 'utf8') };
}

test('export a key’s messages and activity, and a user’s activity', async ({ page, request }) => {
  await signIn(page);
  // a key with traffic
  await page.goto('/ui/keys');
  await page.getByRole('button', { name: 'New key' }).click();
  const keyName = `csv-${run}`;
  await page.getByLabel('Name', { exact: true }).fill(keyName);
  await page.getByLabel('From address', { exact: true }).fill('bot@gateway.test');
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByLabel('Add allowed recipient').fill('@example.com');
  await page.getByLabel('Add allowed recipient').press('Enter');
  await page.getByRole('button', { name: 'Create key' }).click();
  const secret = (await page.getByTestId('api-key-secret').textContent())!.trim();
  await page.getByRole('checkbox', { name: 'I have stored this key securely' }).click();
  await page.getByRole('button', { name: 'Done' }).click();
  for (const subject of ['csv one', '=cmd|calc']) {
    const r = await request.post('/v1/send', { headers: { Authorization: `Bearer ${secret}` }, data: { to: 'a@example.com', subject, text: 'x' } });
    expect(r.status()).toBe(202);
  }

  // key page → Export → messages
  await page.getByRole('button', { name: 'Export', exact: true }).click();
  const msgs = await download(page, () => page.getByTestId('export-key-messages').click());
  expect(msgs.name).toMatch(new RegExp(`^messages-${keyName}-\\d{4}-\\d{2}-\\d{2}\\.csv$`));
  expect(msgs.text.split('\r\n')[0]).toContain('id,created_at,sent_at,status,key_name');
  expect(msgs.text).toContain('csv one');
  expect(msgs.text).toContain("'=cmd|calc"); // formula neutralised

  // key page → Export → activity
  await page.getByRole('button', { name: 'Export', exact: true }).click();
  const act = await download(page, () => page.getByTestId('export-key-activity').click());
  expect(act.name).toContain(`activity-key-${keyName}`);
  expect(act.text).toContain('key.create');

  // users page → my activity
  await page.getByRole('navigation').getByRole('link', { name: 'Admin users' }).click();
  await page.getByRole('row', { name: new RegExp(ADMIN) }).getByRole('button').click();
  const mine = await download(page, () => page.getByTestId(`export-user-activity-${ADMIN}`).click());
  expect(mine.text).toContain('export.messages');
  expect(mine.text.split('\r\n').slice(1, -1).every((l) => l.includes(ADMIN))).toBe(true);

  // activity page filtered by user shows a scope chip
  await page.getByRole('row', { name: new RegExp(ADMIN) }).getByRole('button').click();
  await page.getByRole('menuitem', { name: 'View activity' }).click();
  await expect(page.getByTestId('scope-chip')).toContainText(ADMIN);
});
