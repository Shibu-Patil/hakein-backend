import cron from 'node-cron';
import { Queue } from 'bullmq';
import { getRedis } from '../src/lib/redis.js';
import { prisma } from '../src/lib/prisma.js';
import dotenv from 'dotenv';

dotenv.config();

// Runs every 2 hours: enqueue auto-apply for users with preferences.autoApply === true.
// Works the same regardless of client OS (iOS app / Windows app just use the API).
const EVERY = process.env.SCRAPING_CRON || '0 */2 * * *';

async function tick() {
  try {
    if (!process.env.DATABASE_URL || process.env.DATABASE_URL.includes('<username>')) {
      console.warn('[scheduler] DATABASE_URL not set - skipping');
      return;
    }
    const redis = getRedis();
    if (!redis) { console.warn('[scheduler] REDIS_URL not set - skipping'); return; }
    const users = await prisma.user.findMany({ take: 500 });
    const auto = users.filter((u) => u.preferences?.autoApply);
    if (!auto.length) { console.log('[scheduler] no autoApply users'); return; }
    const queue = new Queue('hakein-jobs', { connection: redis });
    for (const u of auto) {
      await queue.add('auto-apply', {
        userId: u.id,
        provider: 'gemini',
        maxApplies: 5,
        dryRun: process.env.AUTO_APPLY_LIVE === 'true' ? false : true
      });
    }
    await queue.close();
    console.log(`[scheduler] enqueued ${auto.length} users`);
  } catch (e) {
    console.error('[scheduler] tick failed:', e.message);
  }
}

cron.schedule(EVERY, tick);
console.log(`[scheduler] running with cron "${EVERY}". Set AUTO_APPLY_LIVE=true to actually apply (default dry-run).`);
tick();
