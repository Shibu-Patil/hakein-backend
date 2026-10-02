import { Router } from 'express';
import Joi from 'joi';
import { connectDb, dbReady } from '../lib/db.js';
import { Application } from '../models/index.js';
import { getRedis } from '../lib/redis.js';
import { Queue } from 'bullmq';

export const applicationsRoutes = Router();

function fmt(doc) {
  if (!doc) return doc;
  const o = typeof doc.toObject === 'function' ? doc.toObject() : { ...doc };
  o.id = String(o._id);
  if (o.jobId) o.jobId = String(o.jobId);
  if (o.userId) o.userId = String(o.userId);
  if (o.job && o.job._id) o.job.id = String(o.job._id);
  return o;
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
    await connectDb();
    const apps = await Application.find({ userId: req.params.userId })
      .populate('job')
      .sort({ createdAt: -1 })
      .limit(100)
      .lean();
    res.json({ count: apps.length, applications: apps.map(fmt) });
  } catch (e) { next(e); }
});
