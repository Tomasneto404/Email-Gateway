// Authored by Tomás Neto (TN 2026)
import { expect, test, type Page } from '@playwright/test';
import { execSync } from 'node:child_process';

// Guided tour: offered once per user, walks across pages, skips what the role cannot see.
// Sends no email: users are created with the CLI and the tour only reads.
const CLI = process.env.MG_CLI ?? 'docker compose exec -T api node dist/cli.js';
const ROOT = new URL('../..', import.meta.url).pathname;
const run = Date.now().toString(36);
const PASSWORD = 'tour correct horse battery staple';
const ADMIN = `tour-admin-${run}@admins.test`;
const VIEWER = `tour-viewer-${run}@admins.test`;

test.describe.configure({ mode: 'serial' });

test.beforeAll(() => {
  const mk = (email: string, role: string) =>
    execSync(`${CLI} users:create --email ${email} --role ${role} --password-stdin`, { cwd: ROOT, input: PASSWORD, stdio: ['pipe', 'pipe', 'inherit'] });
  mk(ADMIN, 'Admin');
  mk(VIEWER, 'Viewer');
});

async function signIn(page: Page, email: string) {
  await page.goto('/ui/login');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByTestId('current-user')).toHaveText(email);
}

const tourCard = (page: Page) => page.getByTestId('tour').getByRole('dialog');

test('admin walks the whole tour across pages', async ({ page }) => {
  await signIn(page, ADMIN);
  await page.getByTestId('tour-prompt').getByRole('button', { name: 'Take the tour' }).click();

  const card = tourCard(page);
  await expect(card.getByRole('heading', { name: 'How mail-gateway works' })).toBeVisible();
  const total = Number((await card.getByText(/^1 of \d+$/).textContent())!.split(' of ')[1]);
  expect(total).toBe(12);

  await card.getByRole('button', { name: 'Start' }).click();
  const visited: string[] = [];
  for (let i = 2; i <= total; i++) {
    await expect(card.getByText(`${i} of ${total}`)).toBeVisible();
    visited.push(new URL(page.url()).pathname);
    if (i < total) await page.keyboard.press('ArrowRight');
  }
  expect(visited).toEqual(expect.arrayContaining(['/ui/keys', '/ui/messages', '/ui/approvals', '/ui/activity', '/ui/roles']));
  await card.getByRole('button', { name: 'Finish' }).click();
  await expect(page.getByTestId('tour')).toHaveCount(0);

  // Seen: the sidebar offer is gone after a reload; the account menu can still restart it.
  await page.reload();
  await expect(page.getByTestId('current-user')).toBeVisible();
  await expect(page.getByTestId('tour-prompt')).toHaveCount(0);
  await page.getByTestId('current-user').click();
  await page.getByRole('menuitem', { name: 'Guided tour' }).click();
  await expect(tourCard(page)).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('tour')).toHaveCount(0);
});

test('viewer gets a shorter tour without admin-only pages', async ({ page }) => {
  await signIn(page, VIEWER);
  await page.getByTestId('tour-prompt').getByRole('button', { name: 'Take the tour' }).click();
  const card = tourCard(page);
  const total = Number((await card.getByText(/^1 of \d+$/).textContent())!.split(' of ')[1]);
  expect(total).toBeLessThan(12);
  await card.getByRole('button', { name: 'Start' }).click();
  for (let i = 2; i <= total; i++) {
    await expect(card.getByText(`${i} of ${total}`)).toBeVisible();
    expect(new URL(page.url()).pathname).not.toBe('/ui/roles');
    if (i < total) await page.keyboard.press('ArrowRight');
  }
  await card.getByRole('button', { name: 'Finish' }).click();
  await expect(page.getByTestId('tour')).toHaveCount(0);
});

test('dismissing the offer hides it for that user', async ({ page }) => {
  // each test runs in a fresh browser context, so the viewer is offered the tour again here
  await signIn(page, VIEWER);
  const prompt = page.getByTestId('tour-prompt');
  await expect(prompt).toBeVisible();
  await prompt.getByRole('button', { name: 'Dismiss tour' }).click();
  await expect(prompt).toHaveCount(0);
  await page.reload();
  await expect(page.getByTestId('current-user')).toBeVisible();
  await expect(prompt).toHaveCount(0);
});
