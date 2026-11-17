import { expect, test } from '@playwright/test';
import { execSync } from 'node:child_process';

const CLI = process.env.MG_CLI ?? 'docker compose exec -T api node dist/cli.js';
const ROOT = new URL('../..', import.meta.url).pathname;
const run = Date.now().toString(36);
const ADMIN = `secret-admin-${run}@admins.test`;
const PASSWORD = 'secret correct horse battery staple';

test.beforeAll(() => {
  execSync(`${CLI} users:create --email ${ADMIN} --role Admin --password-stdin`, { cwd: ROOT, input: PASSWORD, stdio: ['pipe', 'pipe', 'inherit'] });
});

test('secret is shown once, copied for real, and Done requires confirmation (create + rotate)', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.addInitScript(() => localStorage.setItem('mg-theme', 'dark'));
  await page.goto('/ui/login');
  await page.getByLabel('Email').fill(ADMIN);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByTestId('current-user')).toHaveText(ADMIN);

  const name = `secret-ui-${run}`;
  await page.goto('/ui/keys');
  await page.getByRole('button', { name: 'New key' }).click();
  await page.getByLabel('Name', { exact: true }).fill(name);
  await page.getByLabel('From address', { exact: true }).fill('bot@gateway.test');
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByLabel('Add allowed recipient').fill('@example.com');
  await page.getByLabel('Add allowed recipient').press('Enter');
  await page.getByRole('button', { name: 'Create key' }).click();

  const dialog = page.getByRole('dialog');
  const secret = (await page.getByTestId('api-key-secret').textContent())!.trim();
  expect(secret).toMatch(/^mk_sbx_[0-9A-Za-z]{43}$/);
  await expect(dialog.getByRole('button', { name: 'Done' })).toBeDisabled();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeVisible(); // cannot be dismissed before confirming

  // the secret block stays inside the dialog
  const d = (await dialog.boundingBox())!;
  const b = (await page.getByTestId('api-key-secret').boundingBox())!;
  expect(b.x + b.width).toBeLessThanOrEqual(d.x + d.width);

  await page.getByTestId('copy-secret').click();
  await expect(page.getByTestId('copy-secret')).toHaveText(/Copied/);
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(secret);
  await expect(page.getByRole('checkbox', { name: 'I have stored this key securely' })).toBeChecked();
  await expect(dialog.getByRole('button', { name: 'Done' })).toBeEnabled();
  if (process.env.MG_SHOTS) await page.screenshot({ path: `${process.env.MG_SHOTS}/secret-create.png` });
  await dialog.getByRole('button', { name: 'Done' }).click();

  // rotation
  await page.getByRole('button', { name: 'Key actions' }).click();
  await page.getByRole('menuitem', { name: /Rotate secret/ }).click();
  await page.getByLabel(/Type .* to confirm/).fill(name);
  await page.getByRole('button', { name: 'Rotate secret' }).click();
  await expect(page.getByText('The previous secret has stopped working.')).toBeVisible();
  const rotated = (await page.getByTestId('api-key-secret').textContent())!.trim();
  expect(rotated).not.toBe(secret);
  await page.getByRole('button', { name: 'Try it with curl' }).click();
  await expect(page.getByText(`Authorization: Bearer ${rotated}`)).toBeVisible();
  // with the long curl lines open, everything still fits inside the dialog
  const rd = (await page.getByRole('dialog').boundingBox())!;
  for (const id of ['api-key-secret']) {
    const bb = (await page.getByTestId(id).boundingBox())!;
    expect(bb.x + bb.width).toBeLessThanOrEqual(rd.x + rd.width);
  }
  const pre = (await page.locator('pre', { hasText: 'curl -X POST' }).boundingBox())!;
  expect(pre.x + pre.width).toBeLessThanOrEqual(rd.x + rd.width);
  if (process.env.MG_SHOTS) await page.screenshot({ path: `${process.env.MG_SHOTS}/secret-rotate.png` });
  await page.getByRole('checkbox', { name: 'I have stored this key securely' }).click();
  await page.getByRole('button', { name: 'Done' }).click();
  await expect(page.getByText('The previous secret has stopped working.')).toHaveCount(0);
});
