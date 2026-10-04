import cron from 'node-cron';
import { Queue } from 'bullmq';
import { getRedis } from '../src/lib/redis.js';
import { connectDb, dbConfigured } from '../src/lib/db.js';
import { User } from '../src/models/index.js';
import dotenv from 'dotenv';

dotenv.config();

// Runs every 2 hours: enqueue auto-apply for users with preferences.autoApply === true.
// Live by default: once the user gives credentials, we apply all day without interruption.
const EVERY = process.env.SCRAPING_CRON || '0 */2 * * *';

async function tick() {
  try {
    if (!dbConfigured()) {
      console.warn('[scheduler] DATABASE_URL not set - skipping');
      return;
    }
    const redis = getRedis();
    if (!redis) { console.warn('[scheduler] REDIS_URL not set - skipping'); return; }
    await connectDb();
    const users = await User.find({}).limit(500).lean();
    const auto = users.filter((u) => u.preferences?.autoApply);
    if (!auto.length) { console.log('[scheduler] no autoApply users'); return; }
    const queue = new Queue('hakein-jobs', { connection: redis });
    for (const u of auto) {
      await queue.add('auto-apply', {
        userId: String(u._id),
        provider: 'gemini',
        maxApplies: 5,
        dryRun: process.env.AUTO_APPLY_LIVE === 'false'
      });
    }
    await queue.close();
    console.log(`[scheduler] enqueued ${auto.length} users`);
  } catch (e) {
    console.error('[scheduler] tick failed:', e.message);
  }
}

cron.schedule(EVERY, tick);
console.log(`[scheduler] running with cron "${EVERY}". Live apply by default; set AUTO_APPLY_LIVE=false for dry-run.`);
tick();

// Instant lane: Gmail job-alert ingest every few minutes (your own mailbox = zero ban risk).
// Turn ON job-alert emails: LinkedIn > Jobs > Job alerts > email on; Naukri > alerts on.
const ALERT_EVERY = process.env.ALERT_CRON || '*/3 * * * *';

async function alertTick() {
  try {
    if (!dbConfigured()) return;
    const redis = getRedis();
    if (!redis) return;
    const { fetchAlertLinks } = await import('../src/services/alertIngest.js');
    const { resolveGmailAccount } = await import('../src/services/notify.js');
    const { Job } = await import('../src/models/index.js');
    await connectDb();
    const users = await User.find({}).limit(500).lean();
    const auto = users.filter((u) => u.preferences?.autoApply);
    if (!auto.length) return;
    const queue = new Queue('hakein-jobs', { connection: redis });
    let queued = 0;
    // Each user's OWN mailbox (DB creds first, server env fallback).
    for (const u of auto) {
      const acct = resolveGmailAccount(u);
      if (!acct) continue;
      const { links } = await fetchAlertLinks({ max: 20, imapUser: acct.user, imapPass: acct.pass }).catch(() => ({ links: [] }));
      for (const link of links || []) {
        const exists = await Job.findOne({ source: link.source, externalId: link.externalId }).lean();
        if (exists) continue;
        await queue.add('instant-apply', {
          userId: String(u._id),
          jobUrl: link.url,
          source: link.source,
          externalId: link.externalId,
          titleHint: (link.subject || '').replace(/^(re:\s*)?(\d+\s+new\s+jobs?\s+(for|:)[:\s]*)/i, '').slice(0, 200),
          provider: 'gemini',
          dryRun: process.env.AUTO_APPLY_LIVE === 'false'
        });
        queued++;
      }
    }
    await queue.close();
    if (queued) console.log(`[scheduler] instant-apply queued ${queued} jobs from alerts`);
  } catch (e) {
    console.error('[scheduler] alert tick failed:', e.message);
  }
}

cron.schedule(ALERT_EVERY, alertTick);
console.log(`[scheduler] alert ingest every "${ALERT_EVERY}" (needs GMAIL_USER + GMAIL_APP_PASSWORD + job-alert emails ON).`);
alertTick();
