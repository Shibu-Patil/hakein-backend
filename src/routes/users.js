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
