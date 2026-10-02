import { Router } from 'express';
import Joi from 'joi';
import { ResumeService } from '../services/resumeService.js';
import { JobExtractorService } from '../services/jobExtractor.js';
import { AIProviderFactory } from '../services/aiProviders.js';

export const resumeRoutes = Router();

const resumeService = new ResumeService();
const jobExtractor = new JobExtractorService();

const generateSchema = Joi.object({
  provider: Joi.string().valid('gemini', 'openai', 'anthropic').default('gemini'),
  apiKey: Joi.string().optional(),
  userProfile: Joi.object({
    name: Joi.string().required(),
    email: Joi.string().email().required(),
    phone: Joi.string().optional(),
    location: Joi.string().optional(),
    linkedin: Joi.string().uri().optional(),
    github: Joi.string().uri().optional(),
    summary: Joi.string().optional(),
    experience: Joi.array().items(Joi.object({
      company: Joi.string().required(),
      role: Joi.string().required(),
      startDate: Joi.string().required(),
      endDate: Joi.string().optional(),
      description: Joi.array().items(Joi.string()).required(),
      technologies: Joi.array().items(Joi.string()).optional()
    })).required(),
    education: Joi.array().items(Joi.object({
      institution: Joi.string().required(),
      degree: Joi.string().required(),
      field: Joi.string().required(),
      graduationDate: Joi.string().required(),
      gpa: Joi.string().optional()
    })).required(),
    skills: Joi.object({
      technical: Joi.array().items(Joi.string()).required(),
      soft: Joi.array().items(Joi.string()).optional(),
      tools: Joi.array().items(Joi.string()).optional()
    }).required(),
    projects: Joi.array().items(Joi.object({
      name: Joi.string().required(),
      description: Joi.string().required(),
      technologies: Joi.array().items(Joi.string()).required(),
      link: Joi.string().uri().optional()
    })).optional(),
    certifications: Joi.array().items(Joi.object({
      name: Joi.string().required(),
      issuer: Joi.string().required(),
      date: Joi.string().required()
    })).optional()
  }).required(),
  jobInput: Joi.alternatives().try(
    Joi.object({
      type: Joi.string().valid('jd').required(),
      content: Joi.string().required()
    }),
    Joi.object({
      type: Joi.string().valid('url').required(),
      url: Joi.string().uri().required()
    })
  ).required(),
  options: Joi.object({
    targetRole: Joi.string().optional(),
    emphasis: Joi.array().items(Joi.string()).optional(),
    excludeKeywords: Joi.array().items(Joi.string()).optional(),
    format: Joi.string().valid('ats', 'modern', 'minimal').default('ats')
  }).optional()
});

resumeRoutes.post('/generate', async (req, res, next) => {
  try {
    const { error, value } = generateSchema.validate(req.body);
    if (error) {
      return res.status(400).json({ error: error.details[0].message });
    }

    const { provider, jobInput, options } = value;
    const apiKey = value.apiKey || process.env.GEMINI_API_KEY || process.env.OPENAI_API_KEY;
    if (!apiKey) return res.status(400).json({ error: 'No API key. Pass apiKey or set GEMINI_API_KEY on the server.' });
    const { userProfile } = value;

    let jobDescription;
    if (jobInput.type === 'url') {
      jobDescription = await jobExtractor.extractFromUrl(jobInput.url);
    } else {
      jobDescription = jobInput.content;
    }

    const aiProvider = AIProviderFactory.create(provider, apiKey);
    const result = await resumeService.generateTailoredResume(
      userProfile,
      jobDescription,
      aiProvider,
      options || {}
    );

    res.json(result);
  } catch (err) {
    next(err);
  }
});

resumeRoutes.post('/analyze-ats', async (req, res, next) => {
  try {
    const schema = Joi.object({
      resume: Joi.string().required(),
      jobDescription: Joi.string().required()
    });
    const { error, value } = schema.validate(req.body);
    if (error) {
      return res.status(400).json({ error: error.details[0].message });
    }

    const key = req.body.apiKey || process.env.GEMINI_API_KEY || process.env.OPENAI_API_KEY;
    if (!key) return res.status(400).json({ error: 'No API key. Pass apiKey or set GEMINI_API_KEY on the server.' });
    const aiProvider = AIProviderFactory.create(
      req.body.provider || 'gemini',
      key
    );
    const analysis = await resumeService.analyzeATS(value.resume, value.jobDescription, aiProvider);
    res.json(analysis);
  } catch (err) {
    next(err);
  }
});

resumeRoutes.post('/extract-jd', async (req, res, next) => {
  try {
    const schema = Joi.object({
      url: Joi.string().uri().required()
    });
    const { error, value } = schema.validate(req.body);
    if (error) {
      return res.status(400).json({ error: error.details[0].message });
    }

    const jd = await jobExtractor.extractFromUrl(value.url);
    res.json({ jobDescription: jd });
  } catch (err) {
    next(err);
  }
});