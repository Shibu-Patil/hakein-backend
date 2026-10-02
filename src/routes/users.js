import { Router } from 'express';
import Joi from 'joi';
import { prisma } from '../lib/prisma.js';
import { encrypt } from '../lib/crypto.js';

export const usersRoutes = Router();

function dbReady(res) {
  if (!process.env.DATABASE_URL || process.env.DATABASE_URL.includes('<username>')) {
    res.status(503).json({ error: 'DATABASE_URL (Mongo Atlas) not configured. Set it in .env' });
    return false;
  }
  return true;
}

usersRoutes.post('/', async (req, res, next) => {
  try {
    if (!dbReady(res)) return;
    const schema = Joi.object({
      email: Joi.string().email().required(),
      name: Joi.string().optional(),
      profile: Joi.object().required(),
      preferences: Joi.object({
        keywords: Joi.array().items(Joi.string()).default([]),
        locations: Joi.array().items(Joi.string()).default([]),
        roles: Joi.array().items(Joi.string()).default([]),
        autoApply: Joi.boolean().default(false),
        easyApplyOnly: Joi.boolean().default(true),
        sources: Joi.array().items(Joi.string().valid('linkedin', 'naukri')).default(['linkedin', 'naukri'])
      }).required(),
      naukriEmail: Joi.string().optional(),
      naukriPassword: Joi.string().optional(),
      linkedinEmail: Joi.string().optional(),
      linkedinPassword: Joi.string().optional()
    });
    const { error, value } = schema.validate(req.body);
    if (error) return res.status(400).json({ error: error.details[0].message });

    const data = {
      email: value.email,
      name: value.name,
      profile: value.profile,
      preferences: value.preferences
    };
    if (value.naukriEmail) data.naukriEmail = value.naukriEmail;
    if (value.naukriPassword) data.naukriPassword = encrypt(value.naukriPassword);
    if (value.linkedinEmail) data.linkedinEmail = value.linkedinEmail;
    if (value.linkedinPassword) data.linkedinPassword = encrypt(value.linkedinPassword);

    const user = await prisma.user.upsert({
      where: { email: value.email },
      update: data,
      create: data
    });
    res.json({ id: user.id, email: user.email });
  } catch (e) { next(e); }
});

usersRoutes.get('/:id', async (req, res, next) => {
  try {
    if (!dbReady(res)) return;
    const user = await prisma.user.findUnique({
      where: { id: req.params.id },
      include: { applications: { take: 20, orderBy: { createdAt: 'desc' } } }
    });
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (user.naukriPassword) user.naukriPassword = '***';
    if (user.linkedinPassword) user.linkedinPassword = '***';
    res.json(user);
  } catch (e) { next(e); }
});

usersRoutes.patch('/:id/credentials', async (req, res, next) => {
  try {
    if (!dbReady(res)) return;
    const schema = Joi.object({
      linkedinEmail: Joi.string().optional(),
      linkedinPassword: Joi.string().optional(),
      naukriEmail: Joi.string().optional(),
      naukriPassword: Joi.string().optional()
    }).min(1);
    const { error, value } = schema.validate(req.body);
    if (error) return res.status(400).json({ error: error.details[0].message });
    const data = {};
    if (value.linkedinEmail) data.linkedinEmail = value.linkedinEmail;
    if (value.linkedinPassword) data.linkedinPassword = encrypt(value.linkedinPassword);
    if (value.naukriEmail) data.naukriEmail = value.naukriEmail;
    if (value.naukriPassword) data.naukriPassword = encrypt(value.naukriPassword);
    await prisma.user.update({ where: { id: req.params.id }, data });
    res.json({ ok: true, message: 'Credentials saved (encrypted). Passwords are never returned.' });
  } catch (e) { next(e); }
});

usersRoutes.post('/:id/verify-credentials', async (req, res, next) => {
  try {
    if (!dbReady(res)) return;
    const schema = Joi.object({
      platform: Joi.string().valid('linkedin', 'naukri').required(),
      email: Joi.string().optional(),
      password: Joi.string().optional()
    });
    const { error, value } = schema.validate(req.body);
    if (error) return res.status(400).json({ error: error.details[0].message });
    const { verifyCredentials } = await import('../services/applicationEngine.js');
    const { resolveCredentials } = await import('../services/auth.js');
    const user = await prisma.user.findUnique({ where: { id: req.params.id } });
    if (!user) return res.status(404).json({ error: 'User not found' });
    const creds = (value.email && value.password)
      ? { email: value.email, password: value.password }
      : resolveCredentials(user, value.platform);
    if (!creds) return res.status(400).json({ error: `No ${value.platform} credentials. Save them first or pass email+password.` });
    const result = await verifyCredentials(value.platform, creds);
    res.json(result);
  } catch (e) { next(e); }
});

usersRoutes.patch('/:id/qa-profile', async (req, res, next) => {
  try {
    if (!dbReady(res)) return;
    const schema = Joi.object({
      workAuth: Joi.string().optional(),
      sponsorship: Joi.string().optional(),
      noticeDays: Joi.alternatives().try(Joi.number(), Joi.string()).optional(),
      ctc: Joi.string().optional(),
      expectedCtc: Joi.string().optional(),
      relocation: Joi.string().optional(),
      remote: Joi.string().optional(),
      languages: Joi.array().items(Joi.string()).optional(),
      experienceYears: Joi.alternatives().try(Joi.number(), Joi.string()).optional(),
      location: Joi.string().optional(),
      dob: Joi.string().optional(),
      gender: Joi.string().optional()
    }).min(1).unknown(true);
    const { error, value } = schema.validate(req.body);
    if (error) return res.status(400).json({ error: error.details[0].message });
    const existing = await prisma.user.findUnique({ where: { id: req.params.id }, select: { qaProfile: true } });
    if (!existing) return res.status(404).json({ error: 'User not found' });
    const merged = { ...(existing.qaProfile || {}), ...value };
    await prisma.user.update({ where: { id: req.params.id }, data: { qaProfile: merged } });
    res.json({ ok: true, qaProfile: merged });
  } catch (e) { next(e); }
});

usersRoutes.post('/:id/qa', async (req, res, next) => {
  try {
    if (!dbReady(res)) return;
    const schema = Joi.object({
      question: Joi.string().required(),
      answer: Joi.string().required(),
      source: Joi.string().default('manual')
    });
    const { error, value } = schema.validate(req.body);
    if (error) return res.status(400).json({ error: error.details[0].message });
    const { saveQaPair } = await import('../services/qaService.js');
    const rec = await saveQaPair({ userId: req.params.id, ...value });
    res.json({ ok: true, id: rec.id });
  } catch (e) { next(e); }
});

usersRoutes.get('/:id/qa', async (req, res, next) => {
  try {
    if (!dbReady(res)) return;
    const [user, answers] = await Promise.all([
      prisma.user.findUnique({ where: { id: req.params.id }, select: { qaProfile: true } }),
      prisma.screeningAnswer.findMany({ where: { userId: req.params.id }, orderBy: { updatedAt: 'desc' }, take: 200 })
    ]);
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json({ qaProfile: user.qaProfile || {}, answers });
  } catch (e) { next(e); }
});

// Preview how a question would be answered (stored -> qaProfile -> LLM), without applying.
usersRoutes.post('/:id/answer-preview', async (req, res, next) => {
  try {
    if (!dbReady(res)) return;
    const schema = Joi.object({
      question: Joi.string().required(),
      fieldType: Joi.string().valid('text', 'textarea', 'select', 'radio').default('text'),
      options: Joi.array().items(Joi.string()).default([]),
      jobDescription: Joi.string().optional(),
      provider: Joi.string().valid('gemini', 'openai', 'anthropic').default('gemini'),
      apiKey: Joi.string().optional()
    });
    const { error, value } = schema.validate(req.body);
    if (error) return res.status(400).json({ error: error.details[0].message });
    const user = await prisma.user.findUnique({ where: { id: req.params.id } });
    if (!user) return res.status(404).json({ error: 'User not found' });
    const { answerQuestion } = await import('../services/qaService.js');
    let aiProvider = null;
    const key = value.apiKey || process.env.GEMINI_API_KEY || process.env.OPENAI_API_KEY;
    if (key) {
      const { AIProviderFactory } = await import('../services/aiProviders.js');
      aiProvider = AIProviderFactory.create(value.provider, key);
    }
    const profile = user.profile || {};
    const resumeText = [profile.summary, JSON.stringify(profile.experience || []), JSON.stringify(profile.skills || {})].join('\n').slice(0, 6000);
    const result = await answerQuestion({
      userId: user.id, user,
      question: value.question, fieldType: value.fieldType, options: value.options,
      job: value.jobDescription || '', resumeText, aiProvider
    });
    res.json(result);
  } catch (e) { next(e); }
});

usersRoutes.patch('/:id/preferences', async (req, res, next) => {
  try {
    if (!dbReady(res)) return;
    const user = await prisma.user.update({
      where: { id: req.params.id },
      data: { preferences: req.body }
    });
    res.json({ id: user.id, preferences: user.preferences });
  } catch (e) { next(e); }
});
