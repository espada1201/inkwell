import { expect, test } from './fixtures';

test('planning a network for Kathmandu', async ({ page }) => {
  await page.goto('/#plan/kathmandu/6/near/50');
  await expect(page.getByRole('heading', { name: 'Plan a network' })).toBeVisible();
  await expect(page.locator('[data-city="kathmandu"]')).toHaveAttribute('aria-pressed', 'true');

  // The simulation runs in a worker; the page stays responsive and reports results.
  await expect(page.getByTestId('kpi-detected')).toHaveText(/^\d+\/24$/, { timeout: 30_000 });
  await expect(page.getByTestId('kpi-false')).toHaveText(/^0\/12$/);
  await expect(page.locator('.plan-story')).toContainText('With 50 phones listening across Kathmandu');
  // The "how many phones" curve fills in point by point.
  await expect(page.getByTestId('sweep').locator('circle').first()).toBeVisible({ timeout: 30_000 });

  // Changing the quake re-runs the plan and keeps the choice in the address.
  await page.getByRole('button', { name: 'M7' }).click();
  await expect(page).toHaveURL(/#plan\/kathmandu\/7\/near\/50$/);
  await expect(page.locator('.plan-story')).toContainText('M7', { timeout: 30_000 });

  // The phone count is a keyboard-friendly slider.
  await page.getByRole('slider', { name: 'Phones listening' }).focus();
  await page.keyboard.press('ArrowRight');
  await expect(page.locator('output')).toHaveText('75 phones');
  await expect(page).toHaveURL(/\/75$/);
  await expect(page.locator('.plan-story')).toContainText('With 75 phones', { timeout: 30_000 });
});
