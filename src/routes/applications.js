import { Router } from 'express';
import Joi from 'joi';
import { prisma } from '../lib/prisma.js';
import { getRedis } from '../lib/redis.js';
import { Queue } from 'bullmq';

export const applicationsRoutes = Router();

function dbReady(res) {
  if (!process.env.DATABASE_URL || process.env.DATABASE_URL.includes('<username>')) {
    res.status(503).json({ error: 'DATABASE_URL (Mongo Atlas) not configured. Set it in .env' });
    return false;
  }
  return true;
}

// Enqueue auto-apply run for a user (worker processes scrape + tailor + apply)
applicationsRoutes.post('/auto-apply', async (req, res, next) => {
  try {
    if (!dbReady(res)) return;
    const schema = Joi.object({
      userId: Joi.string().required(),
      provider: Joi.string().valid('gemini', 'openai', 'anthropic').default('gemini'),
      apiKey: Joi.string().optional(),
      maxApplies: Joi.number().min(1).max(20).default(5),
      dryRun: Joi.boolean().default(true)
    });
    const { error, value } = schema.validate(req.body);
    if (error) return res.status(400).json({ error: error.details[0].message });

    const redis = getRedis();
    if (!redis) {
      return res.status(503).json({ error: 'REDIS_URL not configured. Set Redis to enable background auto-apply queue.' });
    }
    const queue = new Queue('hakein-jobs', { connection: redis });
    const job = await queue.add('auto-apply', value, { removeOnComplete: 100, removeOnFail: 100 });
    await queue.close();
    res.json({ queued: true, jobId: job.id, dryRun: value.dryRun });
  } catch (e) { next(e); }
});

// List applications for a user
applicationsRoutes.get('/user/:userId', async (req, res, next) => {
  try {
    if (!dbReady(res)) return;
    const apps = await prisma.application.findMany({
      where: { userId: req.params.userId },
      include: { job: true },
      orderBy: { createdAt: 'desc' },
      take: 100
    });
    res.json({ count: apps.length, applications: apps });
  } catch (e) { next(e); }
});
