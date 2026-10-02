import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolveCredentials, detectBlockerPage } from '../src/services/auth.js';
import { encrypt } from '../src/lib/crypto.js';

process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'test-32-char-encryption-key!!!!';

describe('auth - credential resolution', () => {
  it('resolves LinkedIn creds from stored encrypted user record', () => {
    const user = { linkedinEmail: 'a@b.com', linkedinPassword: encrypt('secret123') };
    const c = resolveCredentials(user, 'linkedin');
    assert.equal(c.email, 'a@b.com');
    assert.equal(c.password, 'secret123');
  });

  it('resolves Naukri creds from stored encrypted user record', () => {
    const user = { naukriEmail: 'n@b.com', naukriPassword: encrypt('pw456') };
    const c = resolveCredentials(user, 'naukri');
    assert.equal(c.email, 'n@b.com');
    assert.equal(c.password, 'pw456');
  });

  it('returns null when no credentials anywhere', () => {
    delete process.env.LINKEDIN_EMAIL;
    delete process.env.NAUKRI_EMAIL;
    assert.equal(resolveCredentials({}, 'linkedin'), null);
    assert.equal(resolveCredentials({}, 'naukri'), null);
  });

  it('falls back to env for testing', () => {
    process.env.LINKEDIN_EMAIL = 'env@li.com';
    process.env.LINKEDIN_PASSWORD = 'envpass';
    const c = resolveCredentials({}, 'linkedin');
    assert.equal(c.email, 'env@li.com');
    delete process.env.LINKEDIN_EMAIL;
    delete process.env.LINKEDIN_PASSWORD;
  });
});

describe('auth - blocker detection', () => {
  it('detects captcha/challenge pages', () => {
    assert.equal(detectBlockerPage('https://www.linkedin.com/checkpoint/challenge/', '<html>captcha</html>'), 'captcha-or-challenge');
  });
  it('detects 2fa pages', () => {
    assert.equal(detectBlockerPage('https://www.linkedin.com/checkpoint/', '<html>two-step verification</html>'), '2fa-or-verify');
  });
  it('returns null for normal pages', () => {
    assert.equal(detectBlockerPage('https://www.linkedin.com/feed/', '<html>feed</html>'), null);
  });
});

describe('api - validation (no network, no DB)', () => {
  it('extract-jd rejects invalid body with 400', async () => {
    const { default: app } = await import('../src/index.js');
    const server = app.listen(0);
    await new Promise((r) => server.on('listening', r));
    const port = server.address().port;
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/resume/extract-jd`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: 'not-a-url' })
      });
      assert.equal(res.status, 400);
    } finally {
      server.close();
    }
  });

  it('health returns ok', async () => {
    const { default: app } = await import('../src/index.js');
    const server = app.listen(0);
    await new Promise((r) => server.on('listening', r));
    const port = server.address().port;
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/health`);
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.status, 'ok');
    } finally {
      server.close();
    }
  });
});

describe('browser - credential verify (gated)', () => {
  it('skips when no creds or no chromium', async (t) => {
    const hasCreds = (process.env.LINKEDIN_EMAIL && process.env.LINKEDIN_PASSWORD) ||
      (process.env.NAUKRI_EMAIL && process.env.NAUKRI_PASSWORD);
    if (!hasCreds) {
      t.skip('Set LINKEDIN_EMAIL/LINKEDIN_PASSWORD or NAUKRI_EMAIL/NAUKRI_PASSWORD to run live login test');
      return;
    }
    const { verifyCredentials } = await import('../src/services/applicationEngine.js');
    const platform = (process.env.LINKEDIN_EMAIL && process.env.LINKEDIN_PASSWORD) ? 'linkedin' : 'naukri';
    const email = process.env[`${platform.toUpperCase()}_EMAIL`];
    const password = process.env[`${platform.toUpperCase()}_PASSWORD`];
    let result;
    try {
      result = await verifyCredentials(platform, { email, password });
    } catch (e) {
      if (/Executable doesn't exist|browser has not been downloaded/i.test(e.message)) {
        t.skip('Playwright chromium not installed. Run: npx playwright install chromium');
        return;
      }
      throw e;
    }
    assert.ok(typeof result.ok === 'boolean', 'verifyCredentials returns { ok }');
  });
});
