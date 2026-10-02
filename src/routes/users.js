import { Router } from 'express';
import Joi from 'joi';
import { connectDb, dbReady } from '../lib/db.js';
import { User, Application, ScreeningAnswer } from '../models/index.js';
import { encrypt } from '../lib/crypto.js';

export const usersRoutes = Router();

function fmt(doc) {
  if (!doc) return doc;
  const o = typeof doc.toObject === 'function' ? doc.toObject() : { ...doc };
  o.id = String(o._id);
  return o;
}

function maskCreds(u) {
  if (u.naukriPassword) u.naukriPassword = '***';
  if (u.linkedinPassword) u.linkedinPassword = '***';
  return u;
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
        sources: Joi.array().items(Joi.string().valid('linkedin', 'naukri')).default(['linkedin', 'naukri']),
        autoAnswerMode: Joi.string().valid('assisted', 'full-auto').default('full-auto'),
        notifyEmail: Joi.string().email().optional(),
        notifyTopic: Joi.string().optional()
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

    await connectDb();
    const user = await User.findOneAndUpdate(
      { email: value.email },
      { $set: data },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
    res.json({ id: String(user._id), email: user.email });
  } catch (e) { next(e); }
});

usersRoutes.get('/:id', async (req, res, next) => {
  try {
    if (!dbReady(res)) return;
    await connectDb();
    const user = await User.findById(req.params.id).lean();
    if (!user) return res.status(404).json({ error: 'User not found' });
    const applications = await Application.find({ userId: user._id })
      .sort({ createdAt: -1 })
      .limit(20)
      .lean();
    res.json(maskCreds({ ...fmt(user), applications: applications.map(fmt) }));
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
    await connectDb();
    await User.findByIdAndUpdate(req.params.id, { $set: data });
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
    await connectDb();
    const user = await User.findById(req.params.id).lean();
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
    await connectDb();
    const existing = await User.findById(req.params.id).lean();
    if (!existing) return res.status(404).json({ error: 'User not found' });
    const merged = { ...(existing.qaProfile || {}), ...value };
    await User.findByIdAndUpdate(req.params.id, { $set: { qaProfile: merged } });
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
    res.json({ ok: true, id: String(rec._id) });
  } catch (e) { next(e); }
});

usersRoutes.get('/:id/qa', async (req, res, next) => {
  try {
    if (!dbReady(res)) return;
    await connectDb();
    const [user, answers] = await Promise.all([
      User.findById(req.params.id).lean(),
      ScreeningAnswer.find({ userId: req.params.id }).sort({ updatedAt: -1 }).limit(200).lean()
    ]);
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json({ qaProfile: user.qaProfile || {}, answers: answers.map(fmt) });
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
    await connectDb();
    const user = await User.findById(req.params.id).lean();
    if (!user) return res.status(404).json({ error: 'User not found' });
    const { answerQuestion } = await import('../services/qaService.js');
    const { defaultAI } = await import('../lib/agentConfig.js');
    let aiProvider = null;
    try {
      aiProvider = value.apiKey
        ? (await import('../services/aiProviders.js')).AIProviderFactory.create(value.provider, value.apiKey)
        : defaultAI('qa');
    } catch {
      aiProvider = null;
    }
    const profile = user.profile || {};
    const resumeText = [profile.summary, JSON.stringify(profile.experience || []), JSON.stringify(profile.skills || {})].join('\n').slice(0, 6000);
    const result = await answerQuestion({
      userId: String(user._id), user: fmt(user),
      question: value.question, fieldType: value.fieldType, options: value.options,
      job: value.jobDescription || '', resumeText, aiProvider
    });
    res.json(result);
  } catch (e) { next(e); }
});

usersRoutes.patch('/:id/preferences', async (req, res, next) => {
  try {
    if (!dbReady(res)) return;
    await connectDb();
    const user = await User.findByIdAndUpdate(
      req.params.id,
      { $set: { preferences: req.body } },
      { new: true }
    ).lean();
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json({ id: String(user._id), preferences: user.preferences });
  } catch (e) { next(e); }
});
