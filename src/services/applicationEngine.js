// Browser automation for LinkedIn Easy Apply + Naukri apply using user id/password.
// Runs SERVER-SIDE (Node + Playwright). iOS/Windows clients call the HTTP API only.

import { resolveCredentials, detectBlockerPage } from './auth.js';

let chromium = null;
async function getChromium() {
  if (!chromium) {
    const { chromium: cw } = await import('playwright');
    chromium = cw;
  }
  return chromium;
}

const HEADLESS = String(process.env.PLAYWRIGHT_HEADLESS ?? 'true') !== 'false';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36';

async function newPage() {
  const cw = await getChromium();
  const browser = await cw.launch({ headless: HEADLESS });
  const context = await browser.newContext({ userAgent: UA });
  const page = await context.newPage();
  return { browser, page };
}

// ---------- login flows ----------

export async function loginLinkedIn(page, { email, password }) {
  await page.goto('https://www.linkedin.com/login', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.fill('#username', email);
  await page.fill('#password', password);
  await page.click('button[type="submit"]');
  await page.waitForTimeout(4000);
  const html = await page.content().catch(() => '');
  const blocker = detectBlockerPage(page.url(), html);
  if (blocker) return { ok: false, error: `LinkedIn ${blocker}. Complete it once in a headed browser, then retry.` };
  const loggedIn = page.url().includes('/feed') || page.url().includes('/in/');
  if (!loggedIn && html.toLowerCase().includes('couldn\'t find a linkedin account')) {
    return { ok: false, error: 'LinkedIn: wrong email/password' };
  }
  if (!loggedIn) return { ok: false, error: `LinkedIn login uncertain (${page.url()}). Check credentials/2FA.` };
  return { ok: true };
}

export async function loginNaukri(page, { email, password }) {
  await page.goto('https://www.naukri.com/nlogin/login', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(2000);
  // Naukri login form: username field + password field
  const userField = page.locator('input[placeholder*="Email"], input[type="text"]').first();
  const passField = page.locator('input[type="password"]').first();
  if (!(await userField.isVisible().catch(() => false))) {
    return { ok: false, error: 'Naukri login form not found (page changed or blocked)' };
  }
  await userField.fill(email);
  await passField.fill(password);
  await page.getByRole('button', { name: /login/i }).first().click();
  await page.waitForTimeout(4000);
  const html = await page.content().catch(() => '');
  if (html.toLowerCase().includes('captcha')) return { ok: false, error: 'Naukri captcha. Retry later or login manually once.' };
  if (html.toLowerCase().includes('invalid')) return { ok: false, error: 'Naukri: wrong email/password' };
  return { ok: true };
}

// ---------- apply flows ----------

async function uploadResumeIfAsked(page, resumePdfBuffer, name) {
  const fileInput = page.locator('input[type="file"]').first();
  if (!(await fileInput.isVisible().catch(() => false))) return false;
  const tmp = (await import('node:os')).tmpdir();
  const path = (await import('node:path')).join(tmp, `${Date.now()}-${(name || 'resume').replace(/[^a-z0-9]+/gi, '_')}.pdf`);
  await (await import('node:fs/promises')).writeFile(path, resumePdfBuffer);
  await fileInput.setInputFiles(path);
  await page.waitForTimeout(1500);
  return true;
}

// Returns true if the Easy Apply modal has questions we should NOT auto-answer
// (free-text inputs, selects, radios beyond contact info).
async function modalHasExtraQuestions(page) {
  const modal = page.locator('.jobs-easy-apply-modal, [role="dialog"]').first();
  if (!(await modal.isVisible().catch(() => false))) return false;
  const texts = await modal.locator('input[type="text"], textarea').count().catch(() => 0);
  const selects = await modal.locator('select').count().catch(() => 0);
  const radios = await modal.locator('input[type="radio"]').count().catch(() => 0);
  return (texts + selects + radios) > 0;
}

async function clickButtonByName(page, names) {
  for (const n of names) {
    const btn = page.getByRole('button', { name: n }).first();
    if (await btn.isVisible().catch(() => false)) {
      await btn.click();
      await page.waitForTimeout(2000);
      return n;
    }
  }
  return null;
}

export async function applyLinkedInEasyApply(page, { job, resumePdfBuffer, userName }) {
  await page.goto(job.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(2000);
  const easyBtn = page.getByRole('button', { name: /easy apply/i }).first();
  if (!(await easyBtn.isVisible().catch(() => false))) {
    return { success: false, skipped: true, error: 'No Easy Apply button (external/company-site apply) - skipped' };
  }
  await easyBtn.click();
  await page.waitForTimeout(2500);

  await uploadResumeIfAsked(page, resumePdfBuffer, userName).catch(() => {});

  // Walk Next/Review steps, max 5. Refuse to auto-answer extra questions.
  for (let step = 0; step < 5; step++) {
    if (await modalHasExtraQuestions(page)) {
      await clickButtonByName(page, [/dismiss/i, /cancel/i, /close/i]).catch(() => {});
      return { success: false, needsReview: true, error: 'Easy Apply has extra questions - saved for manual review, not auto-submitted' };
    }
    const clicked = await clickButtonByName(page, [/^next/i, /review/i, /continue/i]);
    if (!clicked) break;
  }
  if (await modalHasExtraQuestions(page)) {
    return { success: false, needsReview: true, error: 'Easy Apply has extra questions - saved for manual review, not auto-submitted' };
  }
  const submit = page.getByRole('button', { name: /^submit application/i }).first();
  if (await submit.isVisible().catch(() => false)) {
    await submit.click();
    await page.waitForTimeout(2500);
    return { success: true, response: { via: 'linkedin-easy-apply' } };
  }
  // Fallback: generic Submit
  const generic = await clickButtonByName(page, [/^submit$/i]);
  if (generic) return { success: true, response: { via: 'linkedin-easy-apply' } };
  return { success: false, needsReview: true, error: 'Easy Apply flow did not reach Submit - saved for manual review' };
}

export async function applyNaukriDirect(page, { job }) {
  await page.goto(job.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(2000);
  const applyBtn = page.getByRole('button', { name: /apply/i }).first();
  if (!(await applyBtn.isVisible().catch(() => false))) {
    // Some Naukri job pages apply via link
    const applyLink = page.locator('a:has-text("Apply")').first();
    if (!(await applyLink.isVisible().catch(() => false))) {
      return { success: false, skipped: true, error: 'No Apply button found - skipped' };
    }
    await applyLink.click();
  } else {
    await applyBtn.click();
  }
  await page.waitForTimeout(3000);
  const html = await page.content().catch(() => '');
  if (html.toLowerCase().includes('successfully applied') || html.toLowerCase().includes('application submitted')) {
    return { success: true, response: { via: 'naukri-apply' } };
  }
  if (html.toLowerCase().includes('already applied')) {
    return { success: true, response: { via: 'naukri-apply', alreadyApplied: true } };
  }
  // If a chat/questions widget opened, don't guess answers
  if (html.toLowerCase().includes('chat') && html.toLowerCase().includes('question')) {
    return { success: false, needsReview: true, error: 'Naukri asked screening questions - saved for manual review' };
  }
  return { success: true, response: { via: 'naukri-apply' } };
}

// ---------- main entry: credential-based ----------

export async function applyToJob({ job, resumePdfBuffer, user, credentials = {} }) {
  const { browser, page } = await newPage();
  try {
    if (job.source === 'linkedin') {
      const creds = credentials.linkedin || resolveCredentials(user, 'linkedin');
      if (!creds) return { success: false, error: 'LinkedIn credentials missing. Save LinkedIn email+password for the user or set LINKEDIN_EMAIL/LINKEDIN_PASSWORD.' };
      // Optional session-cookie fast path
      if (process.env.LINKEDIN_LI_AT && !creds.forcePassword) {
        await page.context().addCookies([{ name: 'li_at', value: process.env.LINKEDIN_LI_AT, domain: '.linkedin.com', path: '/' }]);
        await page.goto(job.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
        const easyVisible = await page.getByRole('button', { name: /easy apply/i }).first().isVisible().catch(() => false);
        if (!easyVisible && page.url().includes('authwall')) {
          const login = await loginLinkedIn(page, creds);
          if (!login.ok) return { success: false, error: login.error };
        }
      } else {
        const login = await loginLinkedIn(page, creds);
        if (!login.ok) return { success: false, error: login.error };
      }
      return await applyLinkedInEasyApply(page, { job, resumePdfBuffer, userName: user?.profile?.name || user?.name });
    }
    if (job.source === 'naukri') {
      const creds = credentials.naukri || resolveCredentials(user, 'naukri');
      if (!creds) return { success: false, error: 'Naukri credentials missing. Save Naukri email+password for the user or set NAUKRI_EMAIL/NAUKRI_PASSWORD.' };
      const login = await loginNaukri(page, creds);
      if (!login.ok) return { success: false, error: login.error };
      return await applyNaukriDirect(page, { job });
    }
    return { success: false, error: `No apply flow for source: ${job.source}` };
  } catch (e) {
    return { success: false, error: String(e.message || e).slice(0, 500) };
  } finally {
    await browser.close().catch(() => {});
  }
}

// Quick credential check without applying (used by tests + API)
export async function verifyCredentials(platform, { email, password }) {
  const { browser, page } = await newPage();
  try {
    if (platform === 'linkedin') return await loginLinkedIn(page, { email, password });
    if (platform === 'naukri') return await loginNaukri(page, { email, password });
    return { ok: false, error: `Unknown platform: ${platform}` };
  } finally {
    await browser.close().catch(() => {});
  }
}
