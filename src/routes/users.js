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
      naukriPassword: Joi.string().optional()
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
    res.json(user);
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
