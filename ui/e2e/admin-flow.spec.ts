import { expect, test, type Page } from '@playwright/test';
import { execSync } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { totp } from '../../src/auth/totp';

/**
 * Acceptance: first admin created via CLI logs in with password + TOTP, creates a key,
 * sends a test email and sees it in Messages. Also checks the HTML preview sandbox.
 */
const CLI = process.env.MG_CLI ?? 'docker compose exec -T api node dist/cli.js';
const ROOT = new URL('../..', import.meta.url).pathname;
const run = Date.now().toString(36);
const EMAIL = `e2e-${run}@admins.test`;
const PASSWORD = 'e2e correct horse battery staple';
const KEY = `e2e-${run}`;

let secret = '';
let apiKey = '';

test.describe.configure({ mode: 'serial', timeout: 120_000 });

test.beforeAll(() => {
  execSync(`${CLI} users:create --email ${EMAIL} --role admin --password-stdin`, { cwd: ROOT, input: PASSWORD, stdio: ['pipe', 'pipe', 'inherit'] });
});

async function signIn(page: Page) {
  await page.goto('/ui/');
  await expect(page).toHaveURL(/\/ui\/login/);
  await page.getByLabel('Email').fill(EMAIL);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Continue' }).click();
}

/**
 * A code for a step strictly after any previously used one (the server rejects replays and only
 * accepts ±1 step), waiting for the next 30 s window when needed instead of inventing future codes.
 */
let lastStep = 0;
async function nextCode(): Promise<string> {
  let step = Math.floor(Date.now() / 30_000);
  if (step <= lastStep) {
    await new Promise((r) => setTimeout(r, (lastStep + 1) * 30_000 - Date.now() + 200));
    step = Math.floor(Date.now() / 30_000);
  }
  lastStep = step;
  return totp(secret, step * 30_000);
}

test('password-only login, then the user opts in to 2FA from the account menu', async ({ page }) => {
  // 2FA is optional by default: the first login goes straight to the dashboard.
  await signIn(page);
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
  await expect(page.getByTestId('current-user')).toHaveText(EMAIL);
  await expect(page.getByTestId('gateway-state')).toHaveText('Gateway running');

  // Enable TOTP: account menu → Two-factor authentication
  await page.getByTestId('current-user').click();
  await page.getByRole('menuitem', { name: /Two-factor authentication/ }).click();
  await page.getByRole('button', { name: 'Set up authenticator' }).click();
  await expect(page.getByAltText('TOTP QR code')).toBeVisible();
  secret = (await page.getByTestId('account-totp-secret').textContent())!.trim();
  await page.getByLabel('Code from the app').fill(await nextCode());
  await page.getByRole('button', { name: 'Enable two-factor' }).click();
  await expect(page.getByText('Two-factor authentication enabled')).toBeVisible();

  // From now on the code is required at sign-in.
  await page.getByTestId('current-user').click();
  await page.getByRole('menuitem', { name: 'Log out' }).click();
  await signIn(page);
  await expect(page.getByRole('heading', { name: 'Two-factor authentication' })).toBeVisible();
  await page.getByLabel('Authentication code').fill(await nextCode());
  await page.getByRole('button', { name: 'Verify' }).click();
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
});

test('create key → send test email → visible in Messages', async ({ page }) => {
  await signIn(page);
  await page.getByLabel('Authentication code').fill(await nextCode());
  await page.getByRole('button', { name: 'Verify' }).click();
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();

  // Create key wizard
  await page.getByRole('link', { name: 'API keys' }).click();
  await page.getByRole('button', { name: 'New key' }).click();
  await page.getByLabel('Name', { exact: true }).fill(KEY);
  await page.getByLabel('From address', { exact: true }).fill('bot@gateway.test');
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByLabel('Add allowed recipient').fill('@example.com');
  await page.getByLabel('Add allowed recipient').press('Enter');
  await page.getByRole('button', { name: 'Create key' }).click();
  const shown = page.getByTestId('api-key-secret');
  await expect(shown).toContainText('mk_sbx_');
  apiKey = (await shown.textContent())!.trim();
  await page.getByRole('button', { name: "I've stored the key" }).click();

  // Key detail → test send
  await expect(page.getByRole('heading', { name: new RegExp(KEY) })).toBeVisible();
  await page.getByRole('button', { name: 'Send test email' }).click();
  await expect(page.getByLabel('To', { exact: true })).toHaveValue('test@example.com');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.getByTestId('test-send-result')).toContainText('Captured');

  // Messages
  await page.getByRole('link', { name: 'Open in Messages' }).click();
  const drawer = page.getByRole('dialog');
  await expect(drawer).toContainText(`mail-gateway test (${KEY})`);
  await expect(drawer).toContainText('Captured');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('row', { name: new RegExp(`mail-gateway test \\(${KEY}\\)`) })).toBeVisible();

  // The action is in the activity log
  await page.getByRole('link', { name: 'Activity log' }).click();
  await expect(page.getByRole('cell', { name: 'key.test_send' }).first()).toBeVisible();
  await expect(page.getByRole('cell', { name: 'key.create' }).first()).toBeVisible();
});

test('HTML preview cannot run scripts or load remote content by default', async ({ page, request }) => {
  // local "tracker" to detect remote image loads
  const hits: string[] = [];
  const tracker: Server = createServer((req, res) => {
    hits.push(req.url ?? '');
    res.writeHead(200, { 'content-type': 'image/gif' }).end();
  });
  await new Promise<void>((r) => tracker.listen(0, '0.0.0.0', r));
  const port = (tracker.address() as AddressInfo).port;
  try {
    const html = `<p id="target">untouched</p>
      <script>document.getElementById('target').textContent = 'pwned'</script>
      <img src="http://127.0.0.1:${port}/pixel.gif" onerror="document.getElementById('target').textContent='onerror-ran'">`;
    const sent = await request.post('/v1/send', {
      headers: { Authorization: `Bearer ${apiKey}` },
      data: { to: 'html@example.com', subject: `html preview ${run}`, html, text: 'fallback' },
    });
    expect(sent.status()).toBe(202);
    const { id } = await sent.json();

    await signIn(page);
    await page.getByLabel('Authentication code').fill(await nextCode());
    await page.getByRole('button', { name: 'Verify' }).click();
    await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
    await page.goto(`/ui/messages?id=${id}`);
    await page.getByRole('tab', { name: 'Body' }).click();
    const frameEl = page.getByTestId('html-preview');
    await expect(frameEl).toHaveAttribute('sandbox', '');
    const frame = page.frameLocator('[data-testid="html-preview"]');
    await expect(frame.locator('#target')).toHaveText('untouched');
    await page.waitForTimeout(500);
    expect(hits).toHaveLength(0);

    await page.getByRole('button', { name: 'Load remote images' }).click();
    await expect.poll(() => hits.length).toBeGreaterThan(0);
    await expect(frame.locator('#target')).toHaveText('untouched');
  } finally {
    tracker.close();
  }
});
