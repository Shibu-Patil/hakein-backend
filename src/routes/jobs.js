import { Router } from 'express';
import Joi from 'joi';
import { prisma } from '../lib/prisma.js';
import { scrapeJobs } from '../services/scraperService.js';

export const jobsRoutes = Router();

function dbReady(res) {
  if (!process.env.DATABASE_URL || process.env.DATABASE_URL.includes('<username>')) {
    res.status(503).json({ error: 'DATABASE_URL (Mongo Atlas) not configured. Set it in .env' });
    return false;
  }
  return true;
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

    const user = await prisma.user.findUnique({ where: { id: value.userId } });
    if (!user) return res.status(404).json({ error: 'User not found' });

    const result = await scrapeJobs(user, {
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
    if (q) where.title = { contains: q, mode: 'insensitive' };
    const jobs = await prisma.job.findMany({
      where,
      orderBy: { postedAt: 'desc' },
      take: Math.min(parseInt(limit, 10) || 20, 100)
    });
    res.json({ count: jobs.length, jobs });
  } catch (e) { next(e); }
});

// Jobs matched for a user that have not been applied to yet
jobsRoutes.get('/matches/:userId', async (req, res, next) => {
  try {
    if (!dbReady(res)) return;
    const user = await prisma.user.findUnique({ where: { id: req.params.userId } });
    if (!user) return res.status(404).json({ error: 'User not found' });
    const applied = await prisma.application.findMany({
      where: { userId: user.id },
      select: { jobId: true }
    });
    const appliedIds = new Set(applied.map((a) => a.jobId));
    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const jobs = await prisma.job.findMany({
      where: { postedAt: { gte: cutoff } },
      orderBy: { postedAt: 'desc' },
      take: 50
    });
    res.json({ count: jobs.filter((j) => !appliedIds.has(j.id)).length, jobs: jobs.filter((j) => !appliedIds.has(j.id)) });
  } catch (e) { next(e); }
});
