import { Worker, Queue } from 'bullmq';
import { getRedis } from '../src/lib/redis.js';
import { prisma } from '../src/lib/prisma.js';
import { scrapeJobs } from '../src/services/scraperService.js';
import { ResumeService } from '../src/services/resumeService.js';
import { AIProviderFactory } from '../src/services/aiProviders.js';
import { applyToJob } from '../src/services/applicationEngine.js';
import { resumeTextToPdf } from '../src/services/pdfGenerator.js';
import dotenv from 'dotenv';

dotenv.config();

const redis = getRedis();
if (!redis) {
  console.error('[worker] REDIS_URL not set. Start Redis (or Redis Cloud) and set REDIS_URL.');
  process.exit(1);
}

const resumeService = new ResumeService();

new Worker('hakein-jobs', async (job) => {
  if (job.name !== 'auto-apply') return;
  const { userId, provider = 'gemini', apiKey, maxApplies = 5, dryRun = true } = job.data;

  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) throw new Error('User not found');

  // 1. Scrape last-24h jobs and store
  const prefs = user.preferences || {};
  const { jobs } = await scrapeJobs(user, {
    sources: prefs.sources || ['linkedin', 'naukri'],
    hoursBack: 24,
    maxJobs: 50,
    dryRun: false
  });

  // 2. Skip already-applied
  const applied = await prisma.application.findMany({ where: { userId }, select: { jobId: true } });
  const appliedSet = new Set(applied.map((a) => a.jobId));
  const fresh = jobs.filter((j) => !appliedSet.has(j.id)).slice(0, maxApplies);

  const results = [];
  const key = apiKey || process.env.GEMINI_API_KEY || process.env.OPENAI_API_KEY;
  if (!key) throw new Error('No AI apiKey provided and no server fallback key set');

  for (const j of fresh) {
    try {
      // 3. Tailor resume with user's saved profile + this JD
      const ai = AIProviderFactory.create(provider, key);
      const tailored = await resumeService.generateTailoredResume(user.profile, j.description, ai, { format: 'ats' });

      if (dryRun) {
        const app = await prisma.application.create({
          data: { userId, jobId: j.id, status: 'pending', resumeUsed: tailored.resume.slice(0, 15000), response: { dryRun: true, atsScore: tailored.atsScore } }
        });
        results.push({ jobId: j.id, title: j.title, dryRun: true, applicationId: app.id, atsScore: tailored.atsScore });
        continue;
      }

      // 4. Real apply via Playwright (server-side)
      const pdf = await resumeTextToPdf({ name: user.profile?.name || user.name || 'Resume', resumeText: tailored.resume });
      const outcome = await applyToJob({ job: j, resumePdfBuffer: pdf, user });
      const app = await prisma.application.create({
        data: {
          userId, jobId: j.id,
          status: outcome.success ? 'applied' : 'failed',
          resumeUsed: tailored.resume.slice(0, 15000),
          response: outcome.response || {},
          error: outcome.error || null,
          appliedAt: outcome.success ? new Date() : null
        }
      });
      results.push({ jobId: j.id, title: j.title, applied: outcome.success, applicationId: app.id, error: outcome.error });
    } catch (e) {
      results.push({ jobId: j.id, title: j.title, applied: false, error: e.message?.slice(0, 300) });
    }
  }
  return { processed: fresh.length, results };
}, { connection: redis, concurrency: 2 });

console.log('[worker] hakein-jobs worker running. Waiting for auto-apply jobs...');
