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
