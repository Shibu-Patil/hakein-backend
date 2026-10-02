import { Router } from 'express';
import Joi from 'joi';
import rateLimit from 'express-rate-limit';
import multer from 'multer';
import { ResumeService } from '../services/resumeService.js';
import { JobExtractorService } from '../services/jobExtractor.js';
import { AIProviderFactory } from '../services/aiProviders.js';
import { resumeTextToPdf } from '../services/pdfGenerator.js';

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ok = /pdf|msword|officedocument|plain/i.test(file.mimetype) || /\.(pdf|docx?|txt)$/i.test(file.originalname);
    cb(ok ? null : new Error('Only PDF, Word (.doc/.docx) or .txt files allowed'), ok);
  }
});

async function fileToText(file) {
  const name = (file.originalname || '').toLowerCase();
  if (name.endsWith('.pdf') || file.mimetype.includes('pdf')) {
    const pdfParse = (await import('pdf-parse')).default;
    const data = await pdfParse(file.buffer);
    return data.text;
  }
  if (name.endsWith('.docx') || name.endsWith('.doc') || /officedocument|msword/i.test(file.mimetype)) {
    const mammoth = await import('mammoth');
    const out = await mammoth.extractRawText({ buffer: file.buffer });
    return out.value;
  }
  return file.buffer.toString('utf8');
}

// Public endpoint burns the server key: 10 tailors/hour per IP.
const publicLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 10,
  message: { error: 'Public limit reached (10/hour). Setup an account for unlimited use.' }
});

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

// PUBLIC: no login. Paste resume text + JD (or job link) -> tailored ATS resume.
// Uses the server key; strict rate limit guards abuse.
resumeRoutes.post('/tailor-public', publicLimiter, async (req, res, next) => {
  try {
    const schema = Joi.object({
      resumeText: Joi.string().min(50).max(20000).required(),
      jobInput: Joi.alternatives().try(
        Joi.object({ type: Joi.string().valid('jd').required(), content: Joi.string().min(50).max(20000).required() }),
        Joi.object({ type: Joi.string().valid('url').required(), url: Joi.string().uri().required() })
      ).required()
    });
    const { error, value } = schema.validate(req.body);
    if (error) return res.status(400).json({ error: error.details[0].message });

    const apiKey = process.env.GEMINI_API_KEY || process.env.OPENAI_API_KEY;
    if (!apiKey) return res.status(503).json({ error: 'Server AI key not configured.' });

    let jobDescription;
    if (value.jobInput.type === 'url') {
      jobDescription = await jobExtractor.extractFromUrl(value.jobInput.url);
    } else {
      jobDescription = value.jobInput.content;
    }

    const aiProvider = AIProviderFactory.create(process.env.RESUME_PROVIDER || 'gemini', apiKey);
    const result = await resumeService.tailorFromResumeText(value.resumeText, jobDescription, aiProvider, { format: 'ats' });
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// PUBLIC file version: upload resume (PDF / Word / txt) + JD text or job link -> tailored PDF download.
// Returns the PDF file directly; ATS score comes back in the X-ATS-Score header.
resumeRoutes.post('/tailor-file', publicLimiter, upload.single('resume'), async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Attach your resume as resume file (PDF, Word or txt, max 5MB).' });
    const jobText = String(req.body.jobText || '').trim();
    const jobUrl = String(req.body.jobUrl || '').trim();
    if (!jobText && !jobUrl) {
      return res.status(400).json({ error: 'Send jobText (JD) or jobUrl (job link) alongside the file.' });
    }

    const apiKey = process.env.GEMINI_API_KEY || process.env.OPENAI_API_KEY;
    if (!apiKey) return res.status(503).json({ error: 'Server AI key not configured.' });

    const resumeText = (await fileToText(req.file)).replace(/\s+/g, ' ').trim();
    if (resumeText.length < 50) {
      return res.status(400).json({ error: 'Could not read enough text from that file. Try a text-based PDF or DOCX.' });
    }

    const jobDescription = jobUrl && !jobText
      ? await jobExtractor.extractFromUrl(jobUrl)
      : jobText;

    const aiProvider = AIProviderFactory.create(process.env.RESUME_PROVIDER || 'gemini', apiKey);
    const result = await resumeService.tailorFromResumeText(resumeText, jobDescription, aiProvider, { format: 'ats' });
    const pdf = await resumeTextToPdf({
      name: resumeText.split('\n')[0]?.slice(0, 80) || 'Resume',
      resumeText: result.resume
    });

    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': 'attachment; filename="tailored-resume.pdf"',
      'X-ATS-Score': String(result.atsScore?.score ?? ''),
      'Access-Control-Expose-Headers': 'X-ATS-Score'
    });
    res.send(pdf);
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