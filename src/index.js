import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import dotenv from 'dotenv';
import { resumeRoutes } from './routes/resume.js';
import { healthRoutes } from './routes/health.js';
import { usersRoutes } from './routes/users.js';
import { jobsRoutes } from './routes/jobs.js';
import { applicationsRoutes } from './routes/applications.js';
import { inboxRoutes } from './routes/inbox.js';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(helmet());
app.use(cors({
  origin: process.env.FRONTEND_URL?.split(',') || ['http://localhost:5173'],
  credentials: true
}));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: { error: 'Too many requests, please try again later' }
});
app.use('/api/', limiter);

app.use('/api/health', healthRoutes);
app.use('/api/resume', resumeRoutes);
app.use('/api/users', usersRoutes);
app.use('/api/jobs', jobsRoutes);
app.use('/api/applications', applicationsRoutes);
app.use('/api', inboxRoutes);

app.get('/', (req, res) => {
  res.json({
    name: 'hakein-backend',
    version: '1.0.0',
    endpoints: [
      'GET /api/health',
      'POST /api/resume/generate',
      'POST /api/resume/extract-jd',
      'POST /api/resume/analyze-ats',
      'POST /api/users',
      'GET /api/users/:id',
      'PATCH /api/users/:id/preferences',
      'POST /api/jobs/scrape',
      'GET /api/jobs',
      'GET /api/jobs/matches/:userId',
      'POST /api/applications/auto-apply',
      'GET /api/applications/user/:userId',
      'POST /api/applications/:id/retry',
      'GET /api/users/:id/inbox',
      'POST /api/users/:id/inbox/:qid/answer'
    ],
    notes: 'Automation runs server-side. iOS/Windows clients use this HTTP API. Set DATABASE_URL (Mongo Atlas) + REDIS_URL to enable DB/queue.'
  });
});

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error(err.stack);
  const status = err.status || 500;
  res.status(status).json({ error: err.message || 'Internal server error' });
});

const isDirectRun = process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop()) && process.argv[1].includes('src/index.js');

if (isDirectRun) {
  app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    if (!process.env.DATABASE_URL || process.env.DATABASE_URL.includes('<username>')) {
      console.warn('[warn] DATABASE_URL not set - /users /jobs /applications will return 503 until Mongo Atlas URL is set');
    }
    if (!process.env.REDIS_URL) {
      console.warn('[warn] REDIS_URL not set - queue/worker disabled, resume API still works');
    }
  });
}

export default app;
