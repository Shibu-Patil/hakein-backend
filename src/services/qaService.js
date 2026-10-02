import { prisma } from '../lib/prisma.js';

export function normalizeQuestion(q) {
  return String(q || '')
    .toLowerCase()
    .replace(/[*?:.()"'`]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 300);
}

// General-question patterns mapped to qaProfile keys.
// qaProfile example:
// { workAuth: 'yes', sponsorship: 'no', noticeDays: 30, ctc: '12 LPA',
//   expectedCtc: '18 LPA', relocation: 'yes', remote: 'yes',
//   languages: ['English','Hindi'], experienceYears: 4, location: 'Bengaluru' }
const PATTERNS = [
  { keys: ['authoriz', 'legally', 'eligible to work'], qa: 'workAuth' },
  { keys: ['sponsor', 'visa'], qa: 'sponsorship' },
  { keys: ['notice period', 'how soon', 'join'], qa: 'noticeDays' },
  { keys: ['current ctc', 'current salary', 'current compensation'], qa: 'ctc' },
  { keys: ['expected ctc', 'expected salary', 'salary expectation', 'desired salary'], qa: 'expectedCtc' },
  { keys: ['relocat'], qa: 'relocation' },
  { keys: ['remote', 'work from home', 'wfh'], qa: 'remote' },
  { keys: ['total experience', 'years of experience', 'how many years'], qa: 'experienceYears' },
  { keys: ['current location', 'where are you located', 'base location'], qa: 'location' },
  { keys: ['language'], qa: 'languages' },
  { keys: ['phone', 'mobile', 'contact number'], qa: '__profile.phone' },
  { keys: ['email'], qa: '__profile.email' },
  { keys: ['linkedin'], qa: '__profile.linkedin' },
  { keys: ['github', 'portfolio'], qa: '__profile.github' },
  { keys: ['date of birth', 'dob'], qa: 'dob' },
  { keys: ['gender'], qa: 'gender' },
];

const SENSITIVE = ['disability', 'veteran', 'race', 'ethnicity', 'religion', 'pregnan', 'citizenship status'];

export function isSensitive(question) {
  const q = normalizeQuestion(question);
  return SENSITIVE.some((s) => q.includes(s));
}

export function matchQaProfile(question, qaProfile = {}, profile = {}) {
  const q = normalizeQuestion(question);
  for (const p of PATTERNS) {
    if (p.keys.some((k) => q.includes(k))) {
      let val;
      if (p.qa.startsWith('__profile.')) {
        const key = p.qa.split('.')[1];
        val = profile?.[key];
      } else {
        val = qaProfile?.[p.qa];
      }
      if (val !== undefined && val !== null && val !== '') {
        return { answer: Array.isArray(val) ? val.join(', ') : String(val), source: 'qaProfile', key: p.qa };
      }
      return { answer: null, source: 'qaProfile', key: p.qa, missing: true };
    }
  }
  return null;
}

// Pick closest option for select/radio. Exact match first, then case-insensitive
// contains, then yes/no and numeric coercion.
export function coerceToOptions(answer, options = []) {
  if (!options.length) return answer;
  const a = String(answer).trim().toLowerCase();
  const exact = options.find((o) => String(o).trim().toLowerCase() === a);
  if (exact) return exact;
  const yn = { yes: ['yes', 'y', 'true', '1'], no: ['no', 'n', 'false', '0'] };
  for (const opt of options) {
    const o = String(opt).trim().toLowerCase();
    if (yn.yes.includes(a) && yn.yes.includes(o)) return opt;
    if (yn.no.includes(a) && yn.no.includes(o)) return opt;
  }
  const contains = options.find((o) => {
    const ol = String(o).toLowerCase();
    return ol.includes(a) || (a.length > 3 && a.includes(ol));
  });
  if (contains) return contains;
  const num = options.find((o) => String(o).replace(/[^0-9]/g, '') === String(answer).replace(/[^0-9]/g, '') && /\d/.test(String(answer)));
  if (num) return num;
  return null;
}

function parseLlmJson(text) {
  const m = String(text || '').match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch { return null; }
}

export async function llmAnswer({ question, fieldType = 'text', options = [], job, resumeText, aiProvider }) {
  const prompt = `Answer this job application screening question truthfully using ONLY the candidate details below. If the answer is not in the details, reply with confidence "low" and best-effort short answer.

QUESTION: ${question}
FIELD TYPE: ${fieldType}${options.length ? `\nOPTIONS (must pick exactly one): ${options.join(' | ')}` : ''}

CANDIDATE:
${String(resumeText || '').slice(0, 6000)}

JOB (for context on relevance):
${String(job?.description || job || '').slice(0, 3000)}

RULES:
- Keep answers short: yes/no, number, or under 20 words.
- Never invent certifications, degrees, or work authorization.
- Years-of-experience questions: answer with a plain number.
- Salary questions: answer with the number only if present, else "Negotiable".
Return JSON: {"answer":"...","confidence":"high|medium|low"}`;

  const raw = await aiProvider.generate(prompt);
  const parsed = parseLlmJson(raw);
  if (!parsed?.answer) return { answer: null, confidence: 'low', raw: String(raw).slice(0, 500) };
  let answer = String(parsed.answer).trim();
  if (options.length) {
    const coerced = coerceToOptions(answer, options);
    if (!coerced) return { answer: null, confidence: 'low', raw: answer };
    answer = String(coerced);
  }
  return { answer, confidence: parsed.confidence || 'medium' };
}

// Main entry: stored answer -> qaProfile -> LLM. Saves learned answers.
export async function answerQuestion({ userId, user, question, fieldType = 'text', options = [], job, resumeText, aiProvider }) {
  const norm = normalizeQuestion(question);
  if (!norm) return { answer: null, source: 'none', error: 'empty question' };

  // 1. Stored answer (exact norm match, then fuzzy contains)
  try {
    if (userId) {
      const exact = await prisma.screeningAnswer.findUnique({
        where: { userId_questionNorm: { userId, questionNorm: norm } }
      }).catch(() => null);
      if (exact) return { answer: exact.answer, source: 'stored' };
      const all = await prisma.screeningAnswer.findMany({ where: { userId } }).catch(() => []);
      const fuzzy = all.find((r) => norm.includes(r.questionNorm) || r.questionNorm.includes(norm));
      if (fuzzy) return { answer: fuzzy.answer, source: 'stored' };
    }
  } catch { /* db down -> continue */ }

  // 2. General qaProfile / profile fields
  const qaProfile = user?.qaProfile || {};
  const profile = user?.profile || {};
  const matched = matchQaProfile(question, qaProfile, profile);
  if (matched?.answer) {
    const final = options.length ? coerceToOptions(matched.answer, options) : matched.answer;
    if (final) return { answer: String(final), source: 'qaProfile' };
  }

  // 3. Sensitive questions without a stored answer -> do not guess
  if (isSensitive(question)) {
    return { answer: null, source: 'none', error: 'sensitive-no-stored-answer' };
  }

  // 4. LLM with resume + JD
  if (!aiProvider) return { answer: null, source: 'none', error: 'no-ai-provider' };
  const llm = await llmAnswer({ question, fieldType, options, job, resumeText, aiProvider });
  if (!llm.answer) return { answer: null, source: 'none', error: 'llm-no-answer' };
  if (llm.confidence === 'low' && fieldType !== 'text') {
    return { answer: null, source: 'none', error: 'llm-low-confidence' };
  }

  // 5. Learn it
  try {
    if (userId) {
      await prisma.screeningAnswer.upsert({
        where: { userId_questionNorm: { userId, questionNorm: norm } },
        update: { answer: llm.answer, question, source: 'llm' },
        create: { userId, questionNorm: norm, question: String(question).slice(0, 500), answer: llm.answer, source: 'llm' }
      }).catch(() => {});
    }
  } catch { /* ignore */ }

  return { answer: llm.answer, source: 'llm', confidence: llm.confidence };
}

export async function saveQaPair({ userId, question, answer, source = 'manual' }) {
  const norm = normalizeQuestion(question);
  if (!norm || !answer) throw new Error('question and answer required');
  return prisma.screeningAnswer.upsert({
    where: { userId_questionNorm: { userId, questionNorm: norm } },
    update: { answer: String(answer), question: String(question).slice(0, 500), source },
    create: { userId, questionNorm: norm, question: String(question).slice(0, 500), answer: String(answer), source }
  });
}
