import { Router } from 'express';
import Joi from 'joi';
import { connectDb, dbReady } from '../lib/db.js';
import { Job, Application, PendingQuestion } from '../models/index.js';
import { getRedis } from '../lib/redis.js';
import { Queue } from 'bullmq';
import { answerPendingQuestion } from '../services/qaService.js';

export const inboxRoutes = Router();

function fmt(doc) {
  if (!doc) return doc;
  const o = typeof doc.toObject === 'function' ? doc.toObject() : { ...doc };
  o.id = String(o._id);
  return o;
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
    await connectDb();
    const items = await PendingQuestion.find({ userId: req.params.id, status: 'pending' })
      .sort({ createdAt: -1 })
      .limit(50)
      .lean();
    const jobIds = [...new Set(items.map((i) => i.jobId).filter(Boolean))];
    const jobs = jobIds.length ? await Job.find({ _id: { $in: jobIds } }).lean() : [];
    const byId = Object.fromEntries(
      jobs.map((j) => [String(j._id), { id: String(j._id), title: j.title, company: j.company, url: j.url, source: j.source }])
    );
    res.json({
      count: items.length,
      items: items.map((i) => ({ ...fmt(i), job: i.jobId ? byId[String(i.jobId)] || null : null }))
    });
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

    await connectDb();
    const result = await answerPendingQuestion({ userId: req.params.id, pendingId: req.params.qid, answer: value.answer });

    // If this was the last pending question for the application, retry the apply automatically
    let retried = false;
    let remaining = 0;
    if (result.applicationId) {
      remaining = await PendingQuestion.countDocuments({
        applicationId: result.applicationId, status: 'pending'
      }).catch(() => 0);
      if (remaining === 0) {
        await Application.findByIdAndUpdate(result.applicationId, {
          $set: { status: 'pending', error: 'Answered from inbox — retry queued' }
        }).catch(() => {});
        await enqueueRetry(String(result.applicationId), value.provider, value.apiKey);
        retried = true;
      }
    }
    res.json({ ok: true, retried, remainingForApp: remaining });
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
    await connectDb();
    const app = await Application.findById(req.params.id).lean();
    if (!app) return res.status(404).json({ error: 'Application not found' });
    const jobId = await enqueueRetry(String(app._id), value.provider, value.apiKey);
    res.json({ queued: true, jobId });
  } catch (e) { next(e); }
});
