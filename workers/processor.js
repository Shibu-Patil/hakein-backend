import { Worker } from 'bullmq';
import { getRedis } from '../src/lib/redis.js';
import { connectDb } from '../src/lib/db.js';
import { User, Job, Application, PendingQuestion } from '../src/models/index.js';
import { scrapeJobs } from '../src/services/scraperService.js';
import { ResumeService } from '../src/services/resumeService.js';
import { AIProviderFactory } from '../src/services/aiProviders.js';
import { applyToJob } from '../src/services/applicationEngine.js';
import { resumeTextToPdf } from '../src/services/pdfGenerator.js';
import { resolveCredentials } from '../src/services/auth.js';
import { createPendingQuestions } from '../src/services/qaService.js';
import { notifyUser } from '../src/services/notify.js';
import dotenv from 'dotenv';

dotenv.config();

const redis = getRedis();
if (!redis) {
  console.error('[worker] REDIS_URL not set. Start Redis (or Redis Cloud) and set REDIS_URL.');
  process.exit(1);
}

const resumeService = new ResumeService();

function fmtUser(u) {
  const o = typeof u.toObject === 'function' ? u.toObject() : { ...u };
  o.id = String(o._id);
  return o;
}

async function runApply({ user, job, ai, credentials, mode }) {
  const tailored = await resumeService.generateTailoredResume(user.profile, job.description, ai, { format: 'ats' });
  const pdf = await resumeTextToPdf({ name: user.profile?.name || user.name || 'Resume', resumeText: tailored.resume });
  const outcome = await applyToJob({
    job,
    resumePdfBuffer: pdf,
    resumeText: tailored.resume,
    user: { ...user, preferences: { ...(user.preferences || {}), autoAnswerMode: mode } },
    credentials,
    answerCtx: { userId: user.id, user, job, resumeText: tailored.resume, aiProvider: ai, mode }
  });
  return { tailored, outcome };
}

async function saveApplication({ userId, jobId, tailored, outcome }) {
  const status = outcome.success ? 'applied' : (outcome.needsReview ? 'needs_review' : (outcome.skipped ? 'skipped' : 'failed'));
  return Application.create({
    userId, jobId,
    status,
    resumeUsed: tailored.resume.slice(0, 15000),
    response: outcome.response || {},
    answersUsed: outcome.answersUsed || null,
    error: outcome.error || null,
    appliedAt: outcome.success ? new Date() : null
  });
}

// When questions can't be auto-answered: save to mobile inbox + email/push the user.
// Answering from the phone retries the apply automatically.
async function handleNeedsReview({ user, job, app, outcome }) {
  const items = outcome.unanswered || [];
  if (!items.length) return;
  const created = await createPendingQuestions({
    userId: user.id,
    jobId: job.id || job._id,
    applicationId: app._id,
    source: job.source,
    unanswered: items
  }).catch(() => []);
  if (!created.length) return;
  const list = created.slice(0, 5).map((c, i) => `${i + 1}. ${c.question}${c.options?.length ? ` [${c.options.join(' / ')}]` : ''}`).join('\n');
  await notifyUser(user, {
    subject: `Action needed: ${created.length} question(s) for ${job.title} @ ${job.company}`,
    message: `The auto-apply paused — answer these from your phone/computer and it retries automatically:\n\n${list}\n\nOpen Hakein > Inbox, or reply from the Gmail app.`
  });
}

new Worker('hakein-jobs', async (job) => {
  await connectDb();

  // Instant apply: one job URL pushed from Gmail job alerts (minutes after landing).
  if (job.name === 'instant-apply') {
    const { userId, jobUrl, source, externalId, titleHint, provider = 'gemini', apiKey, dryRun = false } = job.data;
    const userDoc = await User.findById(userId).lean();
    if (!userDoc) throw new Error('User not found');
    const user = fmtUser(userDoc);
    const key = apiKey || process.env.GEMINI_API_KEY || process.env.OPENAI_API_KEY;
    if (!key) throw new Error('No AI apiKey');
    const ai = AIProviderFactory.create(provider, key);
    const { JobExtractorService } = await import('../src/services/jobExtractor.js');
    const jd = await new JobExtractorService().extractFromUrl(jobUrl);
    const jobRec = await Job.findOneAndUpdate(
      { source, externalId: String(externalId).slice(0, 200) },
      {
        $setOnInsert: {
          source,
          externalId: String(externalId).slice(0, 200),
          title: String(titleHint || jd.split('\n')[0] || 'Alert job').slice(0, 300),
          company: 'via job alert',
          location: (user.preferences?.locations || ['India'])[0],
          url: jobUrl.slice(0, 1000),
          description: jd.slice(0, 15000),
          postedAt: new Date(),
          rawData: { via: 'gmail-alert' }
        }
      },
      { upsert: true, new: true }
    ).lean();
    const j = { ...jobRec, id: String(jobRec._id) };
    const tailored = await resumeService.generateTailoredResume(user.profile, j.description, ai, { format: 'ats' });
    if (dryRun) {
      const app = await Application.create({
        userId: user._id, jobId: jobRec._id, status: 'pending',
        resumeUsed: tailored.resume.slice(0, 15000),
        response: { dryRun: true, instant: true, atsScore: tailored.atsScore }
      });
      return { instant: true, dryRun: true, applicationId: String(app._id), title: j.title };
    }
    const credentials = { linkedin: resolveCredentials(user, 'linkedin'), naukri: resolveCredentials(user, 'naukri') };
    const mode = (user.preferences || {}).autoAnswerMode || 'full-auto';
    const pdf = await resumeTextToPdf({ name: user.profile?.name || user.name || 'Resume', resumeText: tailored.resume });
    const outcome = await applyToJob({
      job: j,
      resumePdfBuffer: pdf,
      resumeText: tailored.resume,
      user: { ...user, preferences: { ...(user.preferences || {}), autoAnswerMode: mode } },
      credentials,
      answerCtx: { userId: user.id, user, job: j, resumeText: tailored.resume, aiProvider: ai, mode }
    });
    const app = await saveApplication({ userId: user._id, jobId: jobRec._id, tailored, outcome });
    if (outcome.needsReview) {
      await handleNeedsReview({ user, job: j, app, outcome });
    }
    return { instant: true, applied: outcome.success, status: app.status, applicationId: String(app._id), title: j.title };
  }

  if (job.name === 'retry-apply') {
    const { applicationId, provider = 'gemini', apiKey } = job.data;
    const app = await Application.findById(applicationId).populate('job').lean();
    if (!app) throw new Error('Application not found');
    const userDoc = await User.findById(app.userId).lean();
    if (!userDoc) throw new Error('User not found');
    const user = fmtUser(userDoc);
    const key = apiKey || process.env.GEMINI_API_KEY || process.env.OPENAI_API_KEY;
    if (!key) throw new Error('No AI apiKey');
    const ai = AIProviderFactory.create(provider, key);
    const prefs = user.preferences || {};
    const credentials = { linkedin: resolveCredentials(user, 'linkedin'), naukri: resolveCredentials(user, 'naukri') };
    const { tailored, outcome } = await runApply({
      user, job: { ...app.job, id: String(app.job._id) }, ai, credentials, mode: prefs.autoAnswerMode || 'full-auto'
    });
    const status = outcome.success ? 'applied' : (outcome.needsReview ? 'needs_review' : (outcome.skipped ? 'skipped' : 'failed'));
    await Application.findByIdAndUpdate(app._id, {
      $set: {
        status,
        resumeUsed: tailored.resume.slice(0, 15000),
        response: outcome.response || {},
        answersUsed: outcome.answersUsed || null,
        error: outcome.error || null,
        appliedAt: outcome.success ? new Date() : null
      },
      $inc: { retryCount: 1 }
    });
    if (outcome.needsReview) {
      await handleNeedsReview({ user, job: { ...app.job, id: String(app.job._id) }, app, outcome });
    } else {
      // Resolved — close any still-pending inbox items for this application
      await PendingQuestion.updateMany(
        { applicationId: app._id, status: 'pending' },
        { $set: { status: 'expired' } }
      ).catch(() => {});
    }
    return { status, error: outcome.error || null };
  }

  if (job.name !== 'auto-apply') return;
  const { userId, provider = 'gemini', apiKey, maxApplies = 5, dryRun = true } = job.data;

  const userDoc = await User.findById(userId).lean();
  if (!userDoc) throw new Error('User not found');
  const user = fmtUser(userDoc);

  // 1. Scrape last-24h jobs and store (LinkedIn + Naukri)
  const prefs = user.preferences || {};
  const { jobs } = await scrapeJobs(user, {
    sources: prefs.sources || ['linkedin', 'naukri'],
    hoursBack: 24,
    maxJobs: 50,
    dryRun: false
  });

  // 2. Skip already-applied
  const applied = await Application.find({ userId: user._id }).select('jobId').lean();
  const appliedSet = new Set(applied.map((a) => String(a.jobId)));
  const fresh = jobs.filter((j) => !appliedSet.has(String(j.id || j._id))).slice(0, maxApplies);

  const results = [];
  const key = apiKey || process.env.GEMINI_API_KEY || process.env.OPENAI_API_KEY;
  if (!key) throw new Error('No AI apiKey provided and no server fallback key set');

  const credentials = {
    linkedin: resolveCredentials(user, 'linkedin'),
    naukri: resolveCredentials(user, 'naukri')
  };
  const mode = prefs.autoAnswerMode || 'full-auto';

  const ai = AIProviderFactory.create(provider, key);

  for (const j of fresh) {
    try {
      // 3. Tailor resume with user's saved profile + this JD (100% ATS)
      const tailored = await resumeService.generateTailoredResume(user.profile, j.description, ai, { format: 'ats' });

      if (dryRun) {
        const app = await Application.create({
          userId: user._id, jobId: j.id || j._id,
          status: 'pending',
          resumeUsed: tailored.resume.slice(0, 15000),
          response: { dryRun: true, atsScore: tailored.atsScore }
        });
        results.push({ jobId: j.id, title: j.title, source: j.source, dryRun: true, applicationId: String(app._id), atsScore: tailored.atsScore });
        continue;
      }

      // 4. Real apply via Playwright with id/password (server-side).
      // Screening questions: stored Q&A -> qaProfile -> LLM(resume+JD); leftovers -> phone inbox.
      const pdf = await resumeTextToPdf({ name: user.profile?.name || user.name || 'Resume', resumeText: tailored.resume });
      const outcome = await applyToJob({
        job: j,
        resumePdfBuffer: pdf,
        resumeText: tailored.resume,
        user: { ...user, preferences: { ...(user.preferences || {}), autoAnswerMode: mode } },
        credentials,
        answerCtx: { userId: user.id, user, job: j, resumeText: tailored.resume, aiProvider: ai, mode }
      });
      const app = await saveApplication({ userId: user._id, jobId: j.id || j._id, tailored, outcome });
      if (outcome.needsReview) {
        await handleNeedsReview({ user, job: j, app, outcome });
      }
      results.push({ jobId: j.id, title: j.title, source: j.source, applied: outcome.success, status: app.status, applicationId: String(app._id), error: outcome.error, answersUsed: outcome.answersUsed });
    } catch (e) {
      results.push({ jobId: j.id, title: j.title, source: j.source, applied: false, error: e.message?.slice(0, 300) });
    }
  }
  return { processed: fresh.length, results };
}, { connection: redis, concurrency: 2 });

console.log('[worker] hakein-jobs worker running. Waiting for auto-apply / retry-apply jobs...');
