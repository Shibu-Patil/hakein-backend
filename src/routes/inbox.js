import { Router } from 'express';
import Joi from 'joi';
import { prisma } from '../lib/prisma.js';
import { getRedis } from '../lib/redis.js';
import { Queue } from 'bullmq';
import { answerPendingQuestion } from '../services/qaService.js';

export const inboxRoutes = Router();

function dbReady(res) {
  if (!process.env.DATABASE_URL || process.env.DATABASE_URL.includes('<username>')) {
    res.status(503).json({ error: 'DATABASE_URL (Mongo Atlas) not configured. Set it in .env' });
    return false;
  }
  return true;
}

async function enqueueRetry(applicationId, provider = 'gemini', apiKey) {
  const redis = getRedis();
  if (!redis) throw new Error('REDIS_URL not configured. Set Redis to enable apply retry queue.');
  const queue = new Queue('hakein-jobs', { connection: redis });
  const job = await queue.add('retry-apply', { applicationId, provider, apiKey });
  await queue.close();
  return job.id;
}

// Mobile inbox: pending screening questions (poll this from the phone)
inboxRoutes.get('/users/:id/inbox', async (req, res, next) => {
  try {
    if (!dbReady(res)) return;
    const items = await prisma.pendingQuestion.findMany({
      where: { userId: req.params.id, status: 'pending' },
      orderBy: { createdAt: 'desc' },
      take: 50
    });
    const jobIds = [...new Set(items.map((i) => i.jobId).filter(Boolean))];
    const jobs = jobIds.length
      ? await prisma.job.findMany({ where: { id: { in: jobIds } } })
      : [];
    const byId = Object.fromEntries(jobs.map((j) => [j.id, { id: j.id, title: j.title, company: j.company, url: j.url, source: j.source }]));
    res.json({ count: items.length, items: items.map((i) => ({ ...i, job: i.jobId ? byId[i.jobId] || null : null })) });
  } catch (e) { next(e); }
});

// Answer one question from the phone -> learns it -> auto-retries the apply
inboxRoutes.post('/users/:id/inbox/:qid/answer', async (req, res, next) => {
  try {
    if (!dbReady(res)) return;
    const schema = Joi.object({
      answer: Joi.string().required(),
      provider: Joi.string().valid('gemini', 'openai', 'anthropic').default('gemini'),
      apiKey: Joi.string().optional()
    });
    const { error, value } = schema.validate(req.body);
    if (error) return res.status(400).json({ error: error.details[0].message });

    const result = await answerPendingQuestion({ userId: req.params.id, pendingId: req.params.qid, answer: value.answer });

    // If this was the last pending question for the application, retry the apply automatically
    let retried = false;
    if (result.applicationId) {
      const remaining = await prisma.pendingQuestion.count({
        where: { applicationId: result.applicationId, status: 'pending' }
      });
      if (remaining === 0) {
        await prisma.application.update({
          where: { id: result.applicationId },
          data: { status: 'pending', error: 'Answered from inbox — retry queued' }
        }).catch(() => {});
        await enqueueRetry(result.applicationId, value.provider, value.apiKey);
        retried = true;
      }
    }
    res.json({ ok: true, retried, remainingForApp: result.applicationId
      ? await prisma.pendingQuestion.count({ where: { applicationId: result.applicationId, status: 'pending' } }).catch(() => 0)
      : 0 });
  } catch (e) {
    const status = /not found|required|must match/i.test(e.message) ? 400 : 500;
    res.status(status).json({ error: e.message });
  }
});

// Manually retry a needs_review / failed application
inboxRoutes.post('/applications/:id/retry', async (req, res, next) => {
  try {
    if (!dbReady(res)) return;
    const schema = Joi.object({
      provider: Joi.string().valid('gemini', 'openai', 'anthropic').default('gemini'),
      apiKey: Joi.string().optional()
    });
    const { error, value } = schema.validate(req.body || {});
    if (error) return res.status(400).json({ error: error.details[0].message });
    const app = await prisma.application.findUnique({ where: { id: req.params.id } });
    if (!app) return res.status(404).json({ error: 'Application not found' });
    const jobId = await enqueueRetry(app.id, value.provider, value.apiKey);
    res.json({ queued: true, jobId });
  } catch (e) { next(e); }
});
