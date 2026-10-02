// Browser automation for Easy Apply / direct apply.
// Runs SERVER-SIDE (Node + Playwright). Phones (iOS) and Windows PCs call the API;
// they never run Playwright themselves. iOS cannot run Playwright on-device.

let chromium = null;
async function getChromium() {
  if (!chromium) {
    const { chromium: cw } = await import('playwright');
    chromium = cw;
  }
  return chromium;
}

const HEADLESS = String(process.env.PLAYWRIGHT_HEADLESS ?? 'true') !== 'false';

export async function applyToJob({ job, resumePdfBuffer, user }) {
  const cw = await getChromium();
  const browser = await cw.launch({ headless: HEADLESS });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36'
  });
  const page = await context.newPage();
  try {
    if (job.source === 'linkedin') {
      return await applyLinkedIn(page, { job, resumePdfBuffer, user });
    }
    if (job.source === 'naukri') {
      return await applyNaukri(page, { job, resumePdfBuffer, user });
    }
    return { success: false, error: `No apply flow for source: ${job.source}` };
  } catch (e) {
    return { success: false, error: e.message?.slice(0, 500) };
  } finally {
    await browser.close().catch(() => {});
  }
}

async function applyLinkedIn(page, { job, resumePdfBuffer }) {
  // Guest Easy-Apply detection: real apply requires logged-in session cookies.
  // Store LI_AT cookie via env LINKEDIN_LI_AT for server-side apply.
  const liAt = process.env.LINKEDIN_LI_AT;
  if (!liAt) {
    return { success: false, error: 'LINKEDIN_LI_AT not set. Add LinkedIn session cookie to enable auto-apply.' };
  }
  await page.context().addCookies([{ name: 'li_at', value: liAt, domain: '.linkedin.com', path: '/' }]);
  await page.goto(job.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  const easyApply = await page.getByRole('button', { name: /easy apply/i }).first().isVisible().catch(() => false);
  if (!easyApply) return { success: false, error: 'No Easy Apply button (complex apply - skipped)' };
  // Upload resume if file input appears, click through steps conservatively.
  await page.getByRole('button', { name: /easy apply/i }).first().click();
  await page.waitForTimeout(2000);
  // NOTE: full multi-step form filling varies per job; we fill only safe defaults
  // and submit only when a Submit/Review button is reached without extra questions.
  const submit = page.getByRole('button', { name: /^submit/i }).first();
  if (await submit.isVisible().catch(() => false)) {
    await submit.click();
    await page.waitForTimeout(2000);
    return { success: true, response: { via: 'linkedin-easy-apply' } };
  }
  return { success: false, error: 'Easy Apply has extra questions - needs manual review' };
}

async function applyNaukri(page, { job, user }) {
  if (!user?.naukriEmail) return { success: false, error: 'Naukri credentials not saved for user' };
  // Keep login minimal; actual password decrypted by caller and passed via env is safer.
  await page.goto(job.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  const applyBtn = page.getByRole('button', { name: /apply/i }).first();
  if (!(await applyBtn.isVisible().catch(() => false))) {
    return { success: false, error: 'No Apply button found' };
  }
  // Without a valid Naukri session this will land on login; report clearly.
  await applyBtn.click();
  await page.waitForTimeout(2500);
  const loginVisible = await page.getByText(/login/i).first().isVisible().catch(() => false);
  if (loginVisible) return { success: false, error: 'Naukri login required. Save credentials and set NAUKRI session.' };
  return { success: true, response: { via: 'naukri-apply' } };
}
