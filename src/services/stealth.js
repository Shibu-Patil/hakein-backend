// Stealth pack: look like a real laptop browser, not a script.
// Session flow stays DB-cookies (unchanged) — this only fixes *how* we look.

// Runs in every page before any site JS. Hides automation flags,
// fills in the details headless browsers leave blank.
export async function applyStealth(context) {
  await context.addInitScript(() => {
    try {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    } catch { /* ignore */ }
    try {
      Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3] });
    } catch { /* ignore */ }
    try {
      Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
    } catch { /* ignore */ }
    try {
      Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => 8 });
    } catch { /* ignore */ }
    try {
      Object.defineProperty(navigator, 'deviceMemory', { get: () => 8 });
    } catch { /* ignore */ }
    try {
      Object.defineProperty(Screen.prototype, 'width', { get: () => 1440 });
      Object.defineProperty(Screen.prototype, 'height', { get: () => 900 });
    } catch { /* ignore */ }
    try {
      window.chrome = { runtime: {} };
    } catch { /* ignore */ }
  });
}

const rand = (min, max) => min + Math.random() * (max - min);

// Human typing: varied per-key delay instead of metronome timing.
export async function humanType(locator, text, baseDelay = 55) {
  await locator.pressSequentially(String(text || ''), { delay: Math.round(rand(25, 95)) });
  void baseDelay;
}

// Human click: curved path with jitter + settle pause before clicking.
export async function humanClick(page, locator) {
  const box = await locator.boundingBox({ timeout: 10000 }).catch(() => null);
  if (!box) {
    await locator.click({ timeout: 10000 });
    return;
  }
  const vp = page.viewportSize() || { width: 1280, height: 800 };
  let x = Math.random() * vp.width * 0.5;
  let y = Math.random() * vp.height * 0.4 + 100;
  const tx = box.x + box.width * rand(0.35, 0.65);
  const ty = box.y + box.height * rand(0.35, 0.65);
  // 3 curved steps toward the target.
  for (let i = 1; i <= 3; i++) {
    const t = i / 3;
    const cx = x + (tx - x) * t + rand(-14, 14) * (1 - t);
    const cy = y + (ty - y) * t + rand(-10, 10) * (1 - t);
    await page.mouse.move(cx, cy, { steps: 4 });
    await page.waitForTimeout(Math.round(rand(40, 140)));
  }
  await page.mouse.move(tx, ty, { steps: 3 });
  await page.waitForTimeout(Math.round(rand(120, 350)));
  await page.mouse.click(tx, ty);
}
