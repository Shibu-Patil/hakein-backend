import { Router } from 'express';
import Joi from 'joi';
import { connectDb, dbReady } from '../lib/db.js';
import { User, Job, Application } from '../models/index.js';
import { scrapeJobs } from '../services/scraperService.js';

export const jobsRoutes = Router();

function fmt(doc) {
  if (!doc) return doc;
  const o = typeof doc.toObject === 'function' ? doc.toObject() : { ...doc };
  o.id = String(o._id);
  if (o.jobId) o.jobId = String(o.jobId);
  return o;
}

// Trigger a scrape for a user (last 24h, easy-apply filter)
jobsRoutes.post('/scrape', async (req, res, next) => {
  try {
    if (!dbReady(res)) return;
    const schema = Joi.object({
      userId: Joi.string().required(),
      sources: Joi.array().items(Joi.string().valid('linkedin', 'naukri')).default(['linkedin', 'naukri']),
      hoursBack: Joi.number().min(1).max(72).default(24),
      maxJobs: Joi.number().min(1).max(100).default(50),
      dryRun: Joi.boolean().default(false)
    });
    const { error, value } = schema.validate(req.body);
    if (error) return res.status(400).json({ error: error.details[0].message });

    await connectDb();
    const user = await User.findById(value.userId).lean();
    if (!user) return res.status(404).json({ error: 'User not found' });

    const result = await scrapeJobs({ ...user, id: String(user._id) }, {
      sources: value.sources,
      hoursBack: value.hoursBack,
      maxJobs: value.maxJobs,
      dryRun: value.dryRun
    });
    res.json(result);
  } catch (e) { next(e); }
});

// List stored jobs, newest first, optional source filter
jobsRoutes.get('/', async (req, res, next) => {
  try {
    if (!dbReady(res)) return;
    const { source, limit = '20', q } = req.query;
    const where = {};
    if (source) where.source = source;
    if (q) where.title = { $regex: q, $options: 'i' };
    await connectDb();
    const jobs = await Job.find(where)
      .sort({ postedAt: -1 })
      .limit(Math.min(parseInt(limit, 10) || 20, 100))
      .lean();
    res.json({ count: jobs.length, jobs: jobs.map(fmt) });
  } catch (e) { next(e); }
});

// Jobs matched for a user that have not been applied to yet
jobsRoutes.get('/matches/:userId', async (req, res, next) => {
  try {
    if (!dbReady(res)) return;
    await connectDb();
    const user = await User.findById(req.params.userId).lean();
    if (!user) return res.status(404).json({ error: 'User not found' });
    const applied = await Application.find({ userId: user._id }).select('jobId').lean();
    const appliedIds = new Set(applied.map((a) => String(a.jobId)));
    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const jobs = await Job.find({ postedAt: { $gte: cutoff } })
      .sort({ postedAt: -1 })
      .limit(50)
      .lean();
    const fresh = jobs.filter((j) => !appliedIds.has(String(j._id)));
    res.json({ count: fresh.length, jobs: fresh.map(fmt) });
  } catch (e) { next(e); }
});
