// Seeds stored screening Q&A + qaProfile for a user so the apply engine
// answers from DB (no LLM call, no skip) whenever a question matches.
// Usage:
//   npm run db:seed -- --email=you@example.com [--file=data/screening-qa.json] [--dry-run]
// Requires DATABASE_URL (Mongo Atlas) unless --dry-run.
import { readFile } from 'node:fs/promises';
import dotenv from 'dotenv';

dotenv.config();

function arg(name, fallback = null) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (hit) return hit.split('=').slice(1).join('=');
  if (process.argv.includes(`--${name}`)) return true;
  return fallback;
}

const email = arg('email');
const file = arg('file', 'data/screening-qa.json');
const dryRun = process.argv.includes('--dry-run');

if (!email && !dryRun) {
  console.error('Usage: npm run db:seed -- --email=you@example.com [--file=data/screening-qa.json] [--dry-run]');
  process.exit(1);
}

const raw = JSON.parse(await readFile(new URL(`../${file}`, import.meta.url), 'utf8'));
const qaProfile = raw.qaProfile || {};
const answers = (raw.answers || []).filter((a) => a.question && String(a.answer || '').trim());

if (dryRun || !email) {
  console.log(`[dry-run] qaProfile keys: ${Object.keys(qaProfile).filter((k) => String(qaProfile[k] ?? '').trim() !== '').length}`);
  console.log(`[dry-run] answers with values: ${answers.length}/${(raw.answers || []).length}`);
  const empty = (raw.answers || []).filter((a) => !String(a.answer || '').trim()).map((a) => a.question);
  if (empty.length) {
    console.log('[dry-run] still empty (will fall back to LLM):');
    for (const q of empty) console.log(`  - ${q}`);
  }
  process.exit(0);
}

if (!process.env.DATABASE_URL || process.env.DATABASE_URL.includes('<username>')) {
  console.error('DATABASE_URL (Mongo Atlas) not set. Paste your Atlas URL in .env first.');
  process.exit(1);
}

const { connectDb } = await import('../src/lib/db.js');
const { User, ScreeningAnswer } = await import('../src/models/index.js');
const { normalizeQuestion } = await import('../src/services/qaService.js');

await connectDb();

const user = await User.findOne({ email }).lean();
if (!user) {
  console.error(`No user with email ${email}. Create one first: POST /api/users`);
  process.exit(1);
}

const merged = { ...(user.qaProfile || {}), ...Object.fromEntries(Object.entries(qaProfile).filter(([, v]) => String(v ?? '').trim() !== '')) };
await User.findByIdAndUpdate(user._id, { $set: { qaProfile: merged } });
console.log(`[seed] qaProfile merged (${Object.keys(merged).length} keys)`);

let saved = 0;
for (const a of answers) {
  const norm = normalizeQuestion(a.question);
  await ScreeningAnswer.findOneAndUpdate(
    { userId: user._id, questionNorm: norm },
    { $set: { answer: String(a.answer), question: String(a.question).slice(0, 500), source: 'seed' } },
    { upsert: true }
  );
  saved++;
}
console.log(`[seed] saved ${saved} screening answers for ${email}`);
process.exit(0);
