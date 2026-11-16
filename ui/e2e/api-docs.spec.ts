import { expect, test } from '@playwright/test';

// Scalar API reference: renders the spec with no CSP violations and no requests leaving the gateway.
test('Scalar reference at /docs is self-contained', async ({ page, baseURL }) => {
  const origin = new URL(baseURL!).origin;
  const external: string[] = [];
  const problems: string[] = [];
  page.on('request', (r) => {
    const u = new URL(r.url());
    if (!['data:', 'blob:'].includes(u.protocol) && u.origin !== origin) external.push(r.url());
  });
  page.on('console', (m) => m.type() === 'error' && problems.push(m.text()));
  page.on('pageerror', (e) => problems.push(String(e)));

  const res = await page.goto('/docs');
  expect(res?.headers()['content-security-policy']).toContain("script-src 'self'");
  // Scalar-specific root (not Swagger UI)
  await expect(page.locator('.scalar-api-reference').first()).toBeVisible();
  await expect(page.locator('.swagger-ui')).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'mail-gateway', level: 1 })).toBeVisible();
  await expect(page.getByText('Queue an email for delivery').first()).toBeVisible();
  await expect(page.getByText('GET /v1/me', { exact: false }).first()).toBeVisible();
  // give lazy loaders (fonts, workers, telemetry) time to fire if they were going to
  await page.waitForTimeout(2000);
  if (process.env.MG_SHOTS) await page.screenshot({ path: `${process.env.MG_SHOTS}/docs.png` });

  expect(external).toEqual([]);
  expect(problems).toEqual([]);
});
