import nodemailer from 'nodemailer';
import { decrypt } from '../lib/crypto.js';

// Per-user Gmail account: user's own encrypted DB creds first, server env as fallback.
// Returns { user, pass } or null.
export function resolveGmailAccount(user) {
  try {
    if (user?.gmailUser) {
      const pass = user.gmailAppPassword
        ? (() => { try { return decrypt(user.gmailAppPassword); } catch { return null; } })()
        : null;
      if (pass) return { user: user.gmailUser, pass, owner: 'user' };
    }
  } catch { /* fall through to env */ }
  if (process.env.GMAIL_USER && process.env.GMAIL_APP_PASSWORD) {
    return { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD, owner: 'server' };
  }
  return null;
}

const transporters = new Map();

function getTransporter(account) {
  if (!account) return null;
  const key = account.owner === 'user' ? `user:${account.user}` : 'server';
  if (!transporters.has(key)) {
    transporters.set(key, nodemailer.createTransport({
      service: 'gmail',
      auth: { user: account.user, pass: account.pass }
    }));
  }
  return transporters.get(key);
}

export async function sendEmail(to, subject, text, html, account) {
  const t = getTransporter(account || resolveGmailAccount(null));
  if (!t || !to) return false;
  try {
    await t.sendMail({
      from: `"Hakein Job Autopilot" <${(account || {}).user || process.env.GMAIL_USER}>`,
      to,
      subject: String(subject).slice(0, 120),
      text: String(text).slice(0, 4000),
      html: html || `<p>${String(text).slice(0, 4000).replace(/\n/g, '<br>')}</p>`
    });
    return true;
  } catch (e) {
    console.warn('[notify] email failed:', e.message);
    return false;
  }
}

// Free push via ntfy.sh — install ntfy app on phone, subscribe to topic, pops up even with our app closed.
export async function sendPush(topic, title, message) {
  if (!topic) return false;
  try {
    const res = await fetch(`https://ntfy.sh/${encodeURIComponent(topic)}`, {
      method: 'POST',
      headers: { Title: String(title).slice(0, 100) },
      body: String(message).slice(0, 1000)
    });
    return res.ok;
  } catch {
    return false;
  }
}

// Notify BOTH channels (whichever is configured). Reaches the phone even if our app is closed:
// Gmail app push for email, ntfy app push for topic.
export async function notifyUser(user, { subject, message }) {
  const prefs = user?.preferences || {};
  const emailTo = prefs.notifyEmail || user?.email;
  const topic = prefs.notifyTopic || process.env.NTFY_TOPIC;
  const account = resolveGmailAccount(user);
  const [emailOk, pushOk] = await Promise.all([
    sendEmail(emailTo, subject, message, null, account),
    sendPush(topic, subject, message)
  ]);
  return { email: emailOk, push: pushOk };
}
