import { defaultAI } from '../lib/agentConfig.js';

// Captcha / challenge solver: screenshot -> vision LLM -> drive the page.
// Handles: reCAPTCHA checkbox, text captchas, image-select grids, basic sliders.
// Needs a VISION-capable model (cloud: gemini/openai/openrouter/anthropic).
// Text-only local models (e.g. qwen-coder) cannot see images.

function visionAgentName() {
  return process.env.VISION_AGENT || null; // e.g. VISION_AGENT=gemini-flash
}

export async function resolveVisionAI() {
  // Explicit override first, else the qa agent if it has vision, else active agent.
  const names = [visionAgentName(), null];
  let lastErr = null;
  for (const n of names) {
    try {
      const { resolveAgent } = await import('../lib/agentConfig.js');
      const cfg = (await import('../lib/agentConfig.js')).loadAgentConfig();
      const agentName = n || cfg.tasks?.vision || cfg.tasks?.qa || cfg.active;
      const r = resolveAgent(agentName);
      if (r.provider === 'ollama' && !process.env.OLLAMA_VISION_MODEL) {
        throw new Error(`agent "${agentName}" is text-only Ollama (no vision). Set VISION_AGENT to a cloud agent (e.g. gemini-flash) or run a vision model locally.`);
      }
      const { AIProviderFactory } = await import('../services/aiProviders.js');
      void defaultAI;
      return { ai: AIProviderFactory.create(r.provider, r.apiKey, r.model), name: agentName };
    } catch (e) {
      lastErr = e;
      if (n) continue;
      break;
    }
  }
  throw lastErr || new Error('No vision-capable agent available');
}

// Ask a vision model to classify the challenge in a screenshot.
// Returns parsed JSON: { type, grid?, text?, instruction }
export async function classifyChallenge(screenshotB64, mime = 'image/png') {
  const { ai } = await resolveVisionAI();
  const question = `You are solving a login/bot-check screen. Look at this screenshot and reply with ONLY JSON:
{"type":"none|checkbox|text|image-select|slider|unknown","rows":0,"cols":0,"instruction":"..."}
- checkbox: an "I'm not a robot" style checkbox is visible.
- text: distorted letters/numbers to type into a box.
- image-select: a grid of images where you must pick matching ones (give rows/cols of the grid).
- slider: drag-to-unlock slider.
- none: no captcha visible, normal page.`;
  const text = await visionAsk(ai, question, screenshotB64, mime);
  const m = String(text || '').match(/\{[\s\S]*\}/);
  if (!m) return { type: 'unknown', instruction: String(text).slice(0, 200) };
  try {
    return JSON.parse(m[0]);
  } catch {
    return { type: 'unknown', instruction: String(text).slice(0, 200) };
  }
}

// Ask which grid cells match, e.g. {"cells":["R1C2","R3C3"],"done":false}
export async function pickCells(screenshotB64, instruction, rows, cols, mime = 'image/png') {
  const { ai } = await resolveVisionAI();
  const q = `This captcha shows a ${rows}x${cols} image grid. Task: ${instruction}.
Reply with ONLY JSON: {"cells":["R1C1",...]} listing EVERY cell matching the task (rows 1-${rows} top to bottom, cols 1-${cols} left to right). If none match, {"cells":[]}.`;
  const text = await visionAsk(ai, q, screenshotB64, mime);
  const m = String(text || '').match(/\{[\s\S]*\}/);
  if (!m) return { cells: [] };
  try {
    const p = JSON.parse(m[0]);
    return { cells: Array.isArray(p.cells) ? p.cells : [] };
  } catch {
    return { cells: [] };
  }
}

// Read distorted text from a captcha image.
export async function readCaptchaText(screenshotB64, mime = 'image/png') {
  const { ai } = await resolveVisionAI();
  const text = await visionAsk(ai, 'Read ONLY the distorted verification letters/numbers in this image. Reply with just those characters, nothing else.', screenshotB64, mime);
  return String(text || '').replace(/[^A-Za-z0-9]/g, '').slice(0, 12);
}

// Single vision Q&A turn. Supports gemini (inlineData), openai/openrouter
// (image_url), anthropic (base64 source). Falls back to text-only otherwise.
async function visionAsk(ai, question, b64, mime) {
  const provider = ai.constructor.name;
  if (provider === 'GeminiProvider') {
    const { GoogleGenerativeAI } = await import('@google/generative-ai');
    const genAI = new GoogleGenerativeAI(ai.apiKey);
    const model = genAI.getGenerativeModel({ model: ai.model });
    const r = await model.generateContent([
      { text: question },
      { inlineData: { data: b64, mimeType: mime } }
    ]);
    return r.response.text();
  }
  if (provider === 'OpenAIProvider' || provider === 'OpenRouterProvider') {
    const url = provider === 'OpenAIProvider'
      ? 'https://api.openai.com/v1/chat/completions'
      : 'https://openrouter.ai/api/v1/chat/completions';
    const headers = { 'Content-Type': 'application/json' };
    if (provider === 'OpenAIProvider') headers.Authorization = `Bearer ${ai.apiKey}`;
    else {
      headers.Authorization = `Bearer ${ai.apiKey}`;
      headers['HTTP-Referer'] = 'https://github.com/Shibu-Patil/hakein-backend';
    }
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: ai.model,
        max_tokens: 500,
        messages: [{ role: 'user', content: [{ type: 'text', text: question }, { type: 'image_url', image_url: { url: `data:${mime};base64,${b64}` } }] }]
      })
    });
    const data = await res.json();
    return data.choices?.[0]?.message?.content || '';
  }
  if (provider === 'AnthropicProvider') {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': ai.apiKey, 'Content-Type': 'application/json', 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: ai.model,
        max_tokens: 500,
        messages: [{ role: 'user', content: [{ type: 'text', text: question }, { type: 'image', source: { type: 'base64', media_type: mime, data: b64 } }] }]
      })
    });
    const data = await res.json();
    return data.content?.[0]?.text || '';
  }
  throw new Error(`${provider} has no vision support here. Set VISION_AGENT to a cloud vision agent.`);
}

// Convert "R2C3" in a rows×cols grid to page (CSS-pixel) coords inside a bounding box.
export function cellCenter(cell, box, rows, cols) {
  const m = String(cell || '').toUpperCase().match(/R(\d+)C(\d+)/);
  if (!m) return null;
  const r = Math.min(Math.max(parseInt(m[1], 10), 1), rows);
  const c = Math.min(Math.max(parseInt(m[2], 10), 1), cols);
  return {
    x: box.x + ((c - 0.5) / cols) * box.width,
    y: box.y + ((r - 0.5) / rows) * box.height
  };
}

// Email verification codes (LinkedIn "enter the code we emailed you").
// Reads the code from the user's own Gmail via IMAP and fills it. No human needed.
export async function solveEmailCode(page) {
  const user = process.env.GMAIL_USER;
  const pass = process.env.GMAIL_APP_PASSWORD;
  if (!user || !pass) {
    return { solved: false, details: 'email-code challenge needs GMAIL_USER + GMAIL_APP_PASSWORD in backend .env' };
  }
  const { ImapFlow } = await import('imapflow');
  const client = new ImapFlow({ host: 'imap.gmail.com', port: 993, secure: true, auth: { user, pass }, logger: false });
  await client.connect();
  try {
    await client.mailboxOpen('INBOX');
    // Newest LinkedIn mail first (code mails arrive within seconds).
    const uids = await client.search({ from: 'linkedin.com', since: new Date(Date.now() - 30 * 60 * 1000) });
    const take = (uids || []).slice(-3).reverse();
    let code = null;
    for (const uid of take) {
      const msg = await client.fetchOne(String(uid), { bodyParts: ['TEXT'] }).catch(() => null);
      const text = msg?.bodyParts?.get('TEXT')?.toString('utf8') || '';
      const m = text.match(/\b(\d{6})\b/);
      if (m && /verif|code|confirm/i.test(text)) { code = m[1]; break; }
    }
    if (!code) return { solved: false, details: 'no LinkedIn code email arrived yet (wait ~30s, retry)' };
    const input = page.locator('input:not([type="hidden"])').first();
    const box = page.locator('input[type="text"], input:not([type]), input[type="tel"], input[type="number"]').filter({ visible: true }).first();
    const field = (await box.count().catch(() => 0)) ? box : input;
    await field.fill(code);
    await page.waitForTimeout(800);
    const submit = page.getByRole('button', { name: /submit|verify|continue|confirm/i }).first();
    if (await submit.isVisible().catch(() => false)) await submit.click();
    else await page.keyboard.press('Enter');
    await page.waitForTimeout(4000);
    const url = page.url();
    if (!/challenge|checkpoint|verification/i.test(url)) return { solved: true, details: 'email code accepted' };
    return { solved: false, details: 'code submitted but still on challenge (wrong/expired code?)' };
  } finally {
    await client.logout().catch(() => {});
  }
}

// Main entry: look at the page, solve what can be solved. Returns { solved, details }.
export async function solveChallenge(page, { maxRounds = 3 } = {}) {
  // Cheap text check first: email-code challenges don't need vision.
  try {
    const bodyText = (await page.locator('body').innerText({ timeout: 8000 }).catch(() => '')).toLowerCase();
    if (/verification code/.test(bodyText) && /email/.test(bodyText)) {
      const r = await solveEmailCode(page);
      if (r.solved) return r;
      // fall through to vision rounds for other challenge types
      if (/gmail_user|gmail_app/i.test(r.details)) return r;
    }
  } catch { /* continue to vision */ }
  const notes = [];
  for (let round = 0; round < maxRounds; round++) {
    let shot;
    try {
      shot = (await page.screenshot({ timeout: 15000 })).toString('base64');
    } catch (e) {
      return { solved: false, details: `screenshot failed: ${e.message}` };
    }
    let kind;
    try {
      kind = await classifyChallenge(shot);
    } catch (e) {
      return { solved: false, details: `vision unavailable: ${e.message}` };
    }
    notes.push(`round${round + 1}:${kind.type}`);
    if (kind.type === 'none') return { solved: true, details: `clear (${notes.join(',')})` };

    try {
      if (kind.type === 'checkbox') {
        if (await clickCheckbox(page)) {
          await page.waitForTimeout(3000);
          continue; // re-check: checkbox often leads to image challenge next
        }
        return { solved: false, details: 'checkbox not clickable' };
      }
      if (kind.type === 'text') {
        if (await solveTextCaptcha(page, shot)) {
          await page.waitForTimeout(2500);
          continue;
        }
        return { solved: false, details: 'text captcha fill failed' };
      }
      if (kind.type === 'image-select') {
        const done = await solveImageGrid(page, shot, kind);
        if (done) {
          await page.waitForTimeout(2500);
          continue;
        }
        return { solved: false, details: 'image grid solve failed' };
      }
      if (kind.type === 'slider') {
        if (await trySlider(page)) {
          await page.waitForTimeout(2500);
          continue;
        }
        return { solved: false, details: 'slider needs a human (drag varies per challenge)' };
      }
      return { solved: false, details: `unhandled challenge: ${kind.type} (${kind.instruction || ''})`.slice(0, 200) };
    } catch (e) {
      return { solved: false, details: `solve error: ${String(e.message).slice(0, 150)}` };
    }
  }
  return { solved: false, details: `still blocked after ${maxRounds} rounds (${notes.join(',')})` };
}

async function clickCheckbox(page) {
  // reCAPTCHA checkbox lives in an iframe — try frames then page.
  for (const frame of page.frames()) {
    const box = frame.getByRole('checkbox').first();
    if (await box.isVisible().catch(() => false)) {
      await box.click();
      return true;
    }
  }
  const direct = page.locator('iframe[src*="recaptcha"]');
  if (await direct.count()) {
    // Click center of the checkbox iframe (checkbox sits left inside it).
    const bb = await direct.first().boundingBox();
    if (bb) {
      await page.mouse.click(bb.x + 28, bb.y + bb.height / 2);
      return true;
    }
  }
  return false;
}

async function solveTextCaptcha(page, shot) {
  const text = await readCaptchaText(shot);
  if (!text) return false;
  const inputs = page.locator('input[type="text"], input:not([type])');
  const n = await inputs.count().catch(() => 0);
  for (let i = 0; i < n; i++) {
    const f = inputs.nth(i);
    if (!(await f.isVisible().catch(() => false))) continue;
    const val = await f.inputValue().catch(() => '');
    if (val) continue; // probably the login email field — don't overwrite
    await f.fill(text);
    // Submit via Enter, then let caller re-check.
    await page.keyboard.press('Enter');
    return true;
  }
  return false;
}

async function solveImageGrid(page, shot, kind) {
  const rows = Math.min(Math.max(kind.rows || 3, 2), 5);
  const cols = Math.min(Math.max(kind.cols || 3, 2), 5);
  const { cells } = await pickCells(shot, kind.instruction || 'select matching images', rows, cols);
  // Find the captcha image container on the page for coordinate mapping.
  const img = page.locator('img').last();
  const box = await img.boundingBox().catch(() => null);
  const target = box || { x: 0, y: 0, width: 800, height: 600 };
  const base = box || await page.viewportSize().then((v) => ({ x: 0, y: 0, width: v?.width || 800, height: v?.height || 600 })).catch(() => ({ x: 0, y: 0, width: 800, height: 600 }));
  void target;
  for (const cell of cells.slice(0, 9)) {
    const pt = cellCenter(cell, base, rows, cols);
    if (!pt) continue;
    await page.mouse.click(pt.x, pt.y);
    await page.waitForTimeout(600);
  }
  // Click verify/submit if present.
  const submit = page.getByRole('button', { name: /verify|submit|confirm|continue/i }).first();
  if (await submit.isVisible().catch(() => false)) {
    await submit.click();
    return true;
  }
  return cells.length > 0;
}

async function trySlider(page) {
  // Best-effort drag of a slider handle to the right end.
  const handle = page.locator('[class*="slider"], [class*="slide"] [role="slider"], [class*="handle"]').first();
  if (!(await handle.isVisible().catch(() => false))) return false;
  const bb = await handle.boundingBox().catch(() => null);
  if (!bb) return false;
  await page.mouse.move(bb.x + bb.width / 2, bb.y + bb.height / 2);
  await page.mouse.down();
  for (let i = 1; i <= 10; i++) {
    await page.mouse.move(bb.x + bb.width / 2 + (i * bb.width * 3), bb.y + bb.height / 2, { steps: 3 });
    await page.waitForTimeout(120);
  }
  await page.mouse.up();
  return true;
}
