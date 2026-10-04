import { ImapFlow } from 'imapflow';

// Pure: pull LinkedIn / Naukri job links out of email text/html.
export function extractJobLinks(text) {
  const src = String(text || '');
  const found = new Map();

  const liRe = /https?:\/\/(?:www\.)?linkedin\.com[^\s"'<>]*?\/jobs\/view\/(\d+)[^\s"'<>]*/gi;
  let m;
  while ((m = liRe.exec(src))) {
    const id = m[1];
    const key = `linkedin:${id}`;
    if (!found.has(key)) found.set(key, { source: 'linkedin', externalId: id, url: `https://www.linkedin.com/jobs/view/${id}/` });
  }

  // Naukri job links: ...naukri.com/job-listings-<slug>-<id>?... or /job-listings/...-<id>
  const nkRe = /https?:\/\/(?:www\.)?naukri\.com[^\s"'<>]*?(\d{6,})[^\s"'<>]*/gi;
  while ((m = nkRe.exec(src))) {
    const id = m[1];
    const key = `naukri:${id}`;
    if (!found.has(key)) {
      // Rebuild a clean canonical URL from the matched link
      const full = m[0].split(/[?#]/)[0];
      found.set(key, { source: 'naukri', externalId: id, url: full.startsWith('http') ? full : `https://${full}` });
    }
  }

  return [...found.values()];
}

function gmailConfig() {
  const user = process.env.GMAIL_USER;
  const pass = process.env.GMAIL_APP_PASSWORD;
  if (!user || !pass) return null;
  return { user, pass };
}

// Fetch unread LinkedIn/Naukri alert mails, extract job links, mark seen.
// Safe to run every few minutes: it's your own mailbox, zero ban risk on job sites.
export async function fetchAlertLinks({ max = 20, imapUser, imapPass } = {}) {
  const cfg = (imapUser && imapPass)
    ? { user: imapUser, pass: imapPass, owner: 'user' }
    : gmailConfig();
  if (!cfg) return { skipped: 'gmail-not-configured', links: [] };

  const client = new ImapFlow({
    host: 'imap.gmail.com',
    port: 993,
    secure: true,
    auth: { user: cfg.user, pass: cfg.pass },
    logger: false
  });

  const links = [];
  const subjects = [];
  await client.connect();
  try {
    await client.mailboxOpen('INBOX');
    // Unseen mails from job platforms (last ~24h to stay cheap)
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const uids = await client.search({
      seen: false,
      since,
      or: [{ from: 'linkedin.com' }, { from: 'naukri.com' }, { subject: 'jobs' }]
    });
    const take = (uids || []).slice(0, max);
    for (const uid of take) {
      try {
        const msg = await client.fetchOne(String(uid), { bodyParts: ['TEXT'], envelope: true });
        const subject = msg.envelope?.subject || '';
        const text = msg.bodyParts?.get('TEXT')?.toString('utf8') || '';
        const found = extractJobLinks(`${subject}\n${text}`);
        for (const f of found) links.push({ ...f, subject });
        if (found.length || /job/i.test(subject)) {
          subjects.push(subject);
          await client.messageFlagsAdd(String(uid), ['\\Seen']).catch(() => {});
        }
      } catch { /* skip bad mail */ }
    }
  } finally {
    await client.logout().catch(() => {});
  }

  // Dedupe by source+id
  const seen = new Set();
  const unique = links.filter((l) => {
    const k = `${l.source}:${l.externalId}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  return { links: unique, subjects };
}
