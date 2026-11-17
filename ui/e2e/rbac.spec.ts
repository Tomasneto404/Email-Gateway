import { expect, test, type Page } from '@playwright/test';
import { execSync } from 'node:child_process';

const CLI = process.env.MG_CLI ?? 'docker compose exec -T api node dist/cli.js';
const ROOT = new URL('../..', import.meta.url).pathname;
const run = Date.now().toString(36);
const PASSWORD = 'rbac correct horse battery staple';
const ADMIN = `rbac-admin-${run}@admins.test`;
const OPERATOR = `rbac-op-${run}@admins.test`;

test.describe.configure({ mode: 'serial' });

test.beforeAll(() => {
  const mk = (email: string, roles: string) =>
    execSync(`${CLI} users:create --email ${email} ${roles} --password-stdin`, { cwd: ROOT, input: PASSWORD, stdio: ['pipe', 'pipe', 'inherit'] });
  mk(ADMIN, '--role Admin');
  mk(OPERATOR, '--role Operator');
});

async function signIn(page: Page, email: string) {
  await page.goto('/ui/login');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByTestId('current-user')).toHaveText(email);
}

test('Operator sees only what its role allows', async ({ page }) => {
  await signIn(page, OPERATOR);
  await expect(page.getByTestId('current-roles')).toHaveText('Operator');
  const nav = page.getByRole('navigation');
  await expect(nav.getByRole('link', { name: 'API keys' })).toBeVisible();
  await expect(nav.getByRole('link', { name: 'Admin users' })).toHaveCount(0);
  await expect(nav.getByRole('link', { name: 'Roles' })).toHaveCount(0);

  // direct navigation to a forbidden page bounces back
  await page.goto('/ui/users');
  await expect(page).not.toHaveURL(/\/ui\/users/);

  // keys: can create, cannot promote out of sandbox
  await page.goto('/ui/keys');
  await page.getByRole('button', { name: 'New key' }).click();
  await page.getByLabel('Name', { exact: true }).fill(`op-key-${run}`);
  await page.getByLabel('From address', { exact: true }).fill('bot@gateway.test');
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByLabel('Add allowed recipient').fill('@example.com');
  await page.getByLabel('Add allowed recipient').press('Enter');
  await page.getByRole('button', { name: 'Create key' }).click();
  await page.getByRole('checkbox', { name: 'I have stored this key securely' }).click();
  await page.getByRole('button', { name: 'Done' }).click();
  await expect(page.getByRole('radio', { name: 'Live' })).toBeDisabled();
  await expect(page.getByText(/do not allow promoting/)).toBeVisible();
});

test('Admin creates a role and invites a user; the invite dialog fits', async ({ page }) => {
  await signIn(page, ADMIN);
  await page.getByRole('navigation').getByRole('link', { name: 'Roles' }).click();
  await expect(page.getByRole('cell', { name: /Operator/ }).first()).toBeVisible();

  const roleName = `Key rotators ${run}`;
  await page.getByRole('button', { name: 'New role' }).click();
  const dlg = page.getByRole('dialog');
  await dlg.getByLabel('Name').fill(roleName);
  await dlg.getByRole('checkbox', { name: 'keys:read' }).click();
  await dlg.getByRole('checkbox', { name: 'keys:rotate' }).click();
  await dlg.getByRole('button', { name: 'Create role' }).click();
  await expect(page.getByRole('cell', { name: roleName, exact: true })).toBeVisible();

  await page.getByRole('navigation').getByRole('link', { name: 'Admin users' }).click();
  await page.getByRole('button', { name: 'Invite user' }).click();
  const inv = page.getByRole('dialog');
  await inv.getByLabel('Email').fill(`invitee-${run}@example.com`);
  await inv.getByRole('checkbox', { name: roleName }).click();
  await inv.getByRole('button', { name: 'Create invite' }).click();
  const link = inv.getByTestId('invite-link');
  await expect(link).toContainText('/ui/invite/');

  // regression: the long URL must stay inside the dialog
  const d = (await inv.boundingBox())!;
  const l = (await link.locator('..').boundingBox())!;
  expect(l.x + l.width).toBeLessThanOrEqual(d.x + d.width + 0.5);
  if (process.env.MG_SHOTS) await page.screenshot({ path: `${process.env.MG_SHOTS}/invite-dialog.png` });
});
