// LIVE test: LinkedIn login (incl. email-code challenge) + ONE real apply.
// Usage: node scripts/testApplyLive.mjs --email=you@x.com [--maxJobs=1]
import dotenv from 'dotenv';

dotenv.config();

function arg(name, fallback = null) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split('=').slice(1).join('=') : fallback;
}

const { connectDb } = await import('../src/lib/db.js');
const { User } = await import('../src/models/index.js');
const { decrypt } = await import('../src/lib/crypto.js');
const { verifyCredentials, applyToJob } = await import('../src/services/applicationEngine.js');
const { scrapeJobs } = await import('../src/services/scraperService.js');
const { ResumeService } = await import('../src/services/resumeService.js');
const { defaultAI } = await import('../src/lib/agentConfig.js');
const { resumeTextToPdf } = await import('../src/services/pdfGenerator.js');
const { resolveCredentials } = await import('../src/services/auth.js');
const { resolveGmailAccount } = await import('../src/services/notify.js');

await connectDb();
const userDoc = await User.findOne({ email: arg('email') }).lean();
if (!userDoc) throw new Error('User not found');
const user = { ...userDoc, id: String(userDoc._id) };
console.log('USER:', user.email, new Date().toISOString());

// 1. LOGIN (exercises password + email-code challenge via Gmail)
const login = await verifyCredentials('linkedin', {
  email: user.linkedinEmail,
  password: decrypt(user.linkedinPassword),
  gmailAccount: resolveGmailAccount(user)
});
console.log('LOGIN:', JSON.stringify(login));
if (!login.ok) throw new Error('Login failed, aborting apply test');

// 2. Scrape + tailor + apply to ONE job
const maxJobs = Number(arg('maxJobs', 1));
const { jobs } = await scrapeJobs(user, { sources: ['linkedin'], hoursBack: 24, maxJobs, dryRun: false });
console.log('SCRAPED:', jobs.map((j) => `${j.title} @ ${j.company}`));
const ai = defaultAI('resume');
const svc = new ResumeService();
for (const j of jobs.slice(0, maxJobs)) {
  const tailored = await svc.generateTailoredResume(user.profile, j.description, ai, { format: 'ats' });
  const pdf = await resumeTextToPdf({ name: user.profile?.name || user.name, resumeText: tailored.resume });
  const outcome = await applyToJob({
    job: j, resumePdfBuffer: pdf, resumeText: tailored.resume, user,
    credentials: { linkedin: { ...resolveCredentials(user, 'linkedin'), gmailAccount: resolveGmailAccount(user) } },
    answerCtx: { userId: user.id, user, job: j, resumeText: tailored.resume, aiProvider: ai }
  });
  console.log('APPLY:', j.title, '=>', JSON.stringify({ success: outcome.success, error: outcome.error, answers: outcome.answersUsed?.length || 0 }));
}
console.log('DONE', new Date().toISOString());
process.exit(0);
