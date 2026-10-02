import { decrypt } from '../lib/crypto.js';

// Resolve platform credentials: per-user stored (decrypted) first, env fallback for testing.
// Never log passwords. Returns { email, password } or null.
export function resolveCredentials(user, platform) {
  if (platform === 'linkedin') {
    const email = user?.linkedinEmail || process.env.LINKEDIN_EMAIL || null;
    const enc = user?.linkedinPassword || null;
    const password = enc ? safeDecrypt(enc) : (process.env.LINKEDIN_PASSWORD || null);
    if (email && password) return { email, password };
    return null;
  }
  if (platform === 'naukri') {
    const email = user?.naukriEmail || process.env.NAUKRI_EMAIL || null;
    const enc = user?.naukriPassword || null;
    const password = enc ? safeDecrypt(enc) : (process.env.NAUKRI_PASSWORD || null);
    if (email && password) return { email, password };
    return null;
  }
  return null;
}

function safeDecrypt(enc) {
  try {
    const v = decrypt(enc);
    // If decrypt returns empty (wrong key or plain text stored before encryption), fall back to raw
    return v || enc;
  } catch {
    return enc;
  }
}

export function detectBlockerPage(url, html) {
  const u = String(url || '').toLowerCase();
  const h = String(html || '').toLowerCase();
  if (u.includes('checkpoint/challenge') || h.includes('security verification') || h.includes('captcha')) {
    return 'captcha-or-challenge';
  }
  if (u.includes('checkpoint') || h.includes('verify your identity') || h.includes('two-step verification')) {
    return '2fa-or-verify';
  }
  if (u.includes('authwall') || h.includes('sign in to continue')) {
    return 'login-required';
  }
  return null;
}
