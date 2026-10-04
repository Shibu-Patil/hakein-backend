// Browser automation for LinkedIn Easy Apply + Naukri apply using user id/password.
// Runs SERVER-SIDE (Node + Playwright). iOS/Windows clients call the HTTP API only.

import { resolveCredentials, detectBlockerPage } from './auth.js';
import { resolveGmailAccount } from './notify.js';
import { answerQuestion } from './qaService.js';

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

export async function loginLinkedIn(page, { email, password, gmailAccount = null }) {
  await page.goto('https://www.linkedin.com/login', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(2500);
  // LinkedIn randomizes field ids AND renders hidden duplicate forms — locate by type, visible only.
  async function visibleField(selector) {
    const all = page.locator(selector);
    const n = await all.count();
    for (let i = 0; i < n; i++) {
      const f = all.nth(i);
      if (await f.isVisible().catch(() => false)) return f;
    }
    throw new Error(`No visible field: ${selector}`);
  }
  const emailField = await visibleField('input[type="email"], input[type="text"]');
  const passField = await visibleField('input[type="password"]');
  // Instant fill gets silently ignored as bot-like; human-paced typing proceeds.
  await emailField.pressSequentially(email, { delay: 40 });
  await passField.pressSequentially(password, { delay: 40 });
  await page.waitForTimeout(800);
  // Submit button has no type=submit anymore — click by name, else Enter.
  const signIn = page.getByRole('button', { name: /sign in/i }).first();
  if (await signIn.isVisible().catch(() => false)) {
    await signIn.click();
  } else {
    await passField.press('Enter');
  }
  await page.waitForTimeout(4000);
  const html = await page.content().catch(() => '');
  const blocker = detectBlockerPage(page.url(), html);
  if (blocker) {
    // Try vision-solving the challenge (screenshot -> LLM -> click/type), then re-check.
    try {
      const { solveChallenge } = await import('./captchaSolver.js');
      const solved = await solveChallenge(page, { maxRounds: 3, gmailAccount: gmailAccount || resolveGmailAccount(null) });
      const html2 = await page.content().catch(() => '');
      if (solved.solved && !detectBlockerPage(page.url(), html2)) {
        return await finishLinkedInLogin(page);
      }
      return { ok: false, error: `LinkedIn challenge unsolved (${solved.details}). Complete it once in a headed browser, then retry.` };
    } catch (e) {
      return { ok: false, error: `LinkedIn ${blocker} (solver unavailable: ${String(e.message).slice(0, 120)}).` };
    }
  }
  return finishLinkedInLogin(page, html);
}

async function finishLinkedInLogin(page, html) {
  const body = html ?? (await page.content().catch(() => ''));
  const loggedIn = page.url().includes('/feed') || page.url().includes('/in/');
  if (!loggedIn && body.toLowerCase().includes('couldn\'t find a linkedin account')) {
    return { ok: false, error: 'LinkedIn: wrong email/password' };
  }
  if (!loggedIn) return { ok: false, error: `LinkedIn login uncertain (${page.url()}). Check credentials/2FA.` };
  return { ok: true };
}

export async function loginNaukri(page, { email, password, gmailAccount = null }) {
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
  if (html.toLowerCase().includes('captcha')) {
    try {
      const { solveChallenge } = await import('./captchaSolver.js');
      const solved = await solveChallenge(page, { maxRounds: 3, gmailAccount: gmailAccount || resolveGmailAccount(null) });
      const html2 = await page.content().catch(() => '');
      if (solved.solved && !html2.toLowerCase().includes('captcha')) return { ok: true };
      return { ok: false, error: `Naukri captcha unsolved (${solved.details}). Retry later or login manually once.` };
    } catch (e) {
      return { ok: false, error: `Naukri captcha (solver unavailable: ${String(e.message).slice(0, 120)}).` };
    }
  }
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

// Find the label text for a field via its nearest form container.
async function fieldLabel(field) {
  try {
    const container = field.locator('xpath=ancestor::div[contains(@class,"form-element") or contains(@class,"form-item") or contains(@class,"fb-dash")][1]');
    if (await container.count().catch(() => 0)) {
      const t = await container.first().innerText().catch(() => '');
      if (t.trim()) return t.replace(/\s+/g, ' ').trim().slice(0, 300);
    }
  } catch { /* fall through */ }
  try {
    const parent = field.locator('xpath=..');
    const t = await parent.innerText().catch(() => '');
    if (t.trim()) return t.replace(/\s+/g, ' ').trim().slice(0, 300);
  } catch { /* ignore */ }
  return '';
}

function modalScope(page) {
  const modal = page.locator('.jobs-easy-apply-modal, [role="dialog"]').first();
  return modal;
}

// Answer every visible field in the Easy Apply modal using stored Q&A -> qaProfile -> LLM.
// Returns { answered: [{question, answer, source}], unanswered: [{question, reason}] }.
export async function answerLinkedInModal(page, answerCtx) {
  const modal = modalScope(page);
  if (!(await modal.isVisible().catch(() => false))) return { answered: [], unanswered: [] };
  const answered = [];
  const unanswered = [];

  async function handleOne(question, kind, fill, options = []) {
    if (!question) return;
    const r = await answerQuestion({ ...answerCtx, question, fieldType: kind, options });
    if (r.answer) {
      await fill(r.answer);
      answered.push({ question, answer: r.answer, source: r.source });
    } else {
      unanswered.push({ question, fieldType: kind, options, reason: r.error || 'no-answer' });
    }
  }

  // text inputs
  const texts = modal.locator('input[type="text"], input:not([type])');
  const tn = await texts.count().catch(() => 0);
  for (let i = 0; i < tn; i++) {
    const f = texts.nth(i);
    if (!(await f.isVisible().catch(() => false))) continue;
    if (await f.isDisabled().catch(() => false)) continue;
    if (String(await f.inputValue().catch(() => '')).trim()) continue; // pre-filled
    const label = await fieldLabel(f);
    await handleOne(label || `text field ${i + 1}`, 'text', (v) => f.fill(v));
  }

  // textareas
  const areas = modal.locator('textarea');
  const an = await areas.count().catch(() => 0);
  for (let i = 0; i < an; i++) {
    const f = areas.nth(i);
    if (!(await f.isVisible().catch(() => false))) continue;
    if (String(await f.inputValue().catch(() => '')).trim()) continue;
    const label = await fieldLabel(f);
    await handleOne(label || `textarea ${i + 1}`, 'textarea', (v) => f.fill(v));
  }

  // selects
  const selects = modal.locator('select');
  const sn = await selects.count().catch(() => 0);
  for (let i = 0; i < sn; i++) {
    const f = selects.nth(i);
    if (!(await f.isVisible().catch(() => false))) continue;
    const label = await fieldLabel(f);
    const options = await f.locator('option').allInnerTexts().catch(() => []);
    const clean = options.map((o) => o.trim()).filter((o) => o && !/^select/i.test(o));
    await handleOne(label || `select ${i + 1}`, 'select', (v) => f.selectOption({ label: v }).catch(() => f.selectOption(v)), clean);
  }

  // radio groups
  const groups = modal.locator('fieldset, div[role="radiogroup"]');
  const gn = await groups.count().catch(() => 0);
  for (let i = 0; i < gn; i++) {
    const g = groups.nth(i);
    if (!(await g.isVisible().catch(() => false))) continue;
    if (await g.locator('input[type="radio"]:checked').count().catch(() => 0)) continue;
    const label = await g.innerText().catch(() => '');
    const options = await g.locator('input[type="radio"] + label, label').allInnerTexts().catch(() => []);
    const clean = [...new Set(options.map((o) => o.trim()).filter(Boolean))];
    await handleOne(label.replace(/\s+/g, ' ').trim().slice(0, 300) || `radio group ${i + 1}`, 'radio', async (v) => {
      const target = g.locator(`label:has-text("${v}")`).first();
      if (await target.count().catch(() => 0)) await target.click();
      else {
        const radios = g.locator('input[type="radio"]');
        const rn = await radios.count().catch(() => 0);
        for (let k = 0; k < rn; k++) {
          const lbl = await radios.nth(k).locator('xpath=following-sibling::*[1]').innerText().catch(() => '');
          if (lbl.trim().toLowerCase() === String(v).trim().toLowerCase()) {
            await radios.nth(k).check();
            break;
          }
        }
      }
    }, clean);
  }

  return { answered, unanswered };
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

export async function applyLinkedInEasyApply(page, { job, resumePdfBuffer, userName, answerCtx }) {
  await page.goto(job.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(2000);
  const easyBtn = page.getByRole('button', { name: /easy apply/i }).first();
  if (!(await easyBtn.isVisible().catch(() => false))) {
    return { success: false, skipped: true, error: 'No Easy Apply button (external/company-site apply) - skipped' };
  }
  await easyBtn.click();
  await page.waitForTimeout(2500);

  await uploadResumeIfAsked(page, resumePdfBuffer, userName).catch(() => {});

  const allAnswered = [];
  // Walk Next/Review steps, max 5. Auto-answer questions via stored Q&A -> qaProfile -> LLM.
  for (let step = 0; step < 5; step++) {
    const { answered, unanswered } = await answerLinkedInModal(page, answerCtx);
    allAnswered.push(...answered);
    if (unanswered.length) {
      await clickButtonByName(page, [/dismiss/i, /cancel/i, /close/i]).catch(() => {});
      return {
        success: false,
        needsReview: true,
        error: `Unanswered questions: ${unanswered.map((u) => `${u.question} (${u.reason})`).join('; ').slice(0, 400)}`,
        answersUsed: allAnswered,
        unanswered
      };
    }
    const clicked = await clickButtonByName(page, [/^next/i, /review/i, /continue/i]);
    if (!clicked) break;
  }
  const final = await answerLinkedInModal(page, answerCtx);
  allAnswered.push(...final.answered);
  if (final.unanswered.length) {
    return {
      success: false,
      needsReview: true,
      error: `Unanswered questions: ${final.unanswered.map((u) => `${u.question} (${u.reason})`).join('; ').slice(0, 400)}`,
      answersUsed: allAnswered,
      unanswered: final.unanswered
    };
  }
  const submit = page.getByRole('button', { name: /^submit application/i }).first();
  if (await submit.isVisible().catch(() => false)) {
    await submit.click();
    await page.waitForTimeout(2500);
    return { success: true, response: { via: 'linkedin-easy-apply' }, answersUsed: allAnswered };
  }
  // Fallback: generic Submit
  const generic = await clickButtonByName(page, [/^submit$/i]);
  if (generic) return { success: true, response: { via: 'linkedin-easy-apply' }, answersUsed: allAnswered };
  return { success: false, needsReview: true, error: 'Easy Apply flow did not reach Submit - saved for manual review', answersUsed: allAnswered };
}

export async function applyNaukriDirect(page, { job, answerCtx }) {
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
  const answered = [];

  // Naukri screening-chat: answer option buttons or text input via Q&A -> LLM
  for (let round = 0; round < 6; round++) {
    const html = await page.content().catch(() => '');
    const low = html.toLowerCase();
    if (low.includes('successfully applied') || low.includes('application submitted')) {
      return { success: true, response: { via: 'naukri-apply' }, answersUsed: answered };
    }
    if (low.includes('already applied')) {
      return { success: true, response: { via: 'naukri-apply', alreadyApplied: true }, answersUsed: answered };
    }
    // Collect visible bot questions (last few message bubbles)
    const bubbles = page.locator('[class*="chat"] [class*="msg"], [class*="bot"] [class*="text"], [class*="question"]');
    const n = await bubbles.count().catch(() => 0);
    if (!n) break;
    let progressed = false;
    const seen = new Set();
    for (let i = Math.max(0, n - 3); i < n; i++) {
      const q = (await bubbles.nth(i).innerText().catch(() => '')).replace(/\s+/g, ' ').trim();
      if (!q || seen.has(q) || q.length < 4) continue;
      seen.add(q);
      // Prefer option buttons matching this question
      const optBtns = page.locator('button[class*="option"], [class*="options"] button');
      const on = await optBtns.count().catch(() => 0);
      const options = [];
      for (let k = 0; k < Math.min(on, 8); k++) {
        const t = (await optBtns.nth(k).innerText().catch(() => '')).trim();
        if (t) options.push(t);
      }
      // eslint-disable-next-line no-await-in-loop
      const r = await answerQuestion({ ...answerCtx, question: q, fieldType: options.length ? 'radio' : 'text', options });
      if (!r.answer) {
        return { success: false, needsReview: true, error: `Naukri question unanswered: ${q.slice(0, 200)} (${r.error})`, answersUsed: answered, unanswered: [{ question: q, fieldType: options.length ? 'radio' : 'text', options, reason: r.error }] };
      }
      if (options.length) {
        let clicked = false;
        for (let k = 0; k < Math.min(on, 8); k++) {
          const t = (await optBtns.nth(k).innerText().catch(() => '')).trim();
          if (t.toLowerCase() === String(r.answer).toLowerCase()) {
            await optBtns.nth(k).click();
            clicked = true;
            break;
          }
        }
        if (!clicked) {
          return { success: false, needsReview: true, error: `Naukri option not clickable: ${q.slice(0, 150)}`, answersUsed: answered };
        }
      } else {
        const input = page.locator('[class*="chat"] input[type="text"], [class*="chat"] textarea').first();
        if (!(await input.isVisible().catch(() => false))) {
          return { success: false, needsReview: true, error: `Naukri question has no input: ${q.slice(0, 150)}`, answersUsed: answered };
        }
        await input.fill(r.answer);
        await page.keyboard.press('Enter');
      }
      answered.push({ question: q, answer: r.answer, source: r.source });
      progressed = true;
      await page.waitForTimeout(2500);
    }
    if (!progressed) break;
  }

  const html = await page.content().catch(() => '');
  const low = html.toLowerCase();
  if (low.includes('successfully applied') || low.includes('application submitted')) {
    return { success: true, response: { via: 'naukri-apply' }, answersUsed: answered };
  }
  if (low.includes('already applied')) {
    return { success: true, response: { via: 'naukri-apply', alreadyApplied: true }, answersUsed: answered };
  }
  return { success: true, response: { via: 'naukri-apply' }, answersUsed: answered };
}

// ---------- main entry: credential-based ----------

export async function applyToJob({ job, resumePdfBuffer, resumeText, user, credentials = {}, answerCtx = {} }) {
  const { browser, page } = await newPage();
  try {
    const ctx = {
      userId: user?.id || answerCtx.userId || null,
      user,
      job,
      resumeText: resumeText || answerCtx.resumeText || '',
      aiProvider: answerCtx.aiProvider || null
    };
    const gmailAccount = resolveGmailAccount(user);
    if (job.source === 'linkedin') {
      const creds = credentials.linkedin || resolveCredentials(user, 'linkedin');
      if (!creds) return { success: false, error: 'LinkedIn credentials missing. Save LinkedIn email+password for the user or set LINKEDIN_EMAIL/LINKEDIN_PASSWORD.' };
      creds.gmailAccount = creds.gmailAccount || gmailAccount;
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
      return await applyLinkedInEasyApply(page, { job, resumePdfBuffer, userName: user?.profile?.name || user?.name, answerCtx: ctx });
    }
    if (job.source === 'naukri') {
      const creds = credentials.naukri || resolveCredentials(user, 'naukri');
      if (!creds) return { success: false, error: 'Naukri credentials missing. Save Naukri email+password for the user or set NAUKRI_EMAIL/NAUKRI_PASSWORD.' };
      creds.gmailAccount = creds.gmailAccount || gmailAccount;
      const login = await loginNaukri(page, creds);
      if (!login.ok) return { success: false, error: login.error };
      return await applyNaukriDirect(page, { job, answerCtx: ctx });
    }
    return { success: false, error: `No apply flow for source: ${job.source}` };
  } catch (e) {
    return { success: false, error: String(e.message || e).slice(0, 500) };
  } finally {
    await browser.close().catch(() => {});
  }
}

// Quick credential check without applying (used by tests + API)
export async function verifyCredentials(platform, { email, password, gmailAccount = null }) {
  const { browser, page } = await newPage();
  try {
    if (platform === 'linkedin') return await loginLinkedIn(page, { email, password, gmailAccount });
    if (platform === 'naukri') return await loginNaukri(page, { email, password, gmailAccount });
    return { ok: false, error: `Unknown platform: ${platform}` };
  } finally {
    await browser.close().catch(() => {});
  }
}
