# Hakein Backend — AI Job Autopilot API

Express + MongoDB (Atlas) + Redis (BullMQ) + Playwright backend that watches LinkedIn + Naukri 24×7,
tailors a resume per job with 100% ATS formatting, answers screening questions automatically,
and applies — all day, without interruption.

Frontend: [`hakein-frontend`](../heakein-frontend) (3 simple pages: Home, Setup, Inbox).

## How it works

```
Scheduler (every 2h) → Scrape last-24h jobs → Tailor resume per JD (ATS)
  → Login as user (LinkedIn/Naukri id+password) → Easy Apply / direct apply
  → Screening questions auto-answered (stored → general → LLM)
  → Leftover questions → phone Inbox + free Gmail alert → answer retries apply
```

**Answer priority** (cheapest first, so LLM is rarely called):
1. `ScreeningAnswer` — exact/fuzzy match on previously answered questions (learns forever)
2. `qaProfile` — general answers (work auth, sponsorship, notice, CTC, relocation…)
3. LLM (Gemini / OpenAI / Anthropic) with resume + that job's JD, coerced to visible options
4. Only truly unanswerable items → `needs_review` + mobile inbox + email

## Quick start

```bash
npm install
npx playwright install chromium   # only needed for live apply / login tests
cp .env.example .env              # then fill DATABASE_URL + REDIS_URL + keys (below)
npm start                         # API on :3000 (collections are created automatically on first write)
npm run worker                    # background apply worker (separate terminal)
npm run scheduler                 # 2-hour watch loop (separate terminal)
```

Minimal `.env` to go live:

```env
DATABASE_URL="mongodb+srv://<user>:<pass>@cluster0.xxxxx.mongodb.net/hakein?retryWrites=true&w=majority"
REDIS_URL="redis://localhost:6379"
GEMINI_API_KEY="<your key>"          # server fallback; users can also pass per-request apiKey
ENCRYPTION_KEY="a-32-char-secret-string-here!!"
GMAIL_USER="you@gmail.com"           # free phone alerts via Gmail app
GMAIL_APP_PASSWORD="xxxx xxxx xxxx xxxx"  # Google Account → 2-Step Verification → App passwords
```

Optional: `LINKEDIN_EMAIL/LINKEDIN_PASSWORD`, `NAUKRI_EMAIL/NAUKRI_PASSWORD` (env fallback for
testing — per-user stored credentials take priority), `LINKEDIN_LI_AT` (session-cookie fast path),
`NTFY_TOPIC` (extra push via ntfy.sh), `AUTO_APPLY_LIVE=false` (force dry-run),
`PLAYWRIGHT_HEADLESS=true`, `SCRAPING_CRON="0 */2 * * *"`.

## API reference

Base: `http://localhost:3000`. All bodies/returns are JSON.

### Health

| Method | Path | Notes |
|---|---|---|
| GET | `/api/health` | `{ status: "ok" }` — no DB needed |
| GET | `/` | Endpoint list |

### Resume

| Method | Path | Body | Returns |
|---|---|---|---|
| POST | `/api/resume/generate` | `provider` (`gemini`\|`openai`\|`anthropic`), `apiKey`, `userProfile` (see below), `jobInput`: `{ type: "jd", content }` or `{ type: "url", url }`, `options: { format: "ats" }` | `{ id, resume (plain text), analysis, atsScore, metadata }` |
| POST | `/api/resume/extract-jd` | `{ url }` | `{ jobDescription }` — pulls JD out of any job link |
| POST | `/api/resume/analyze-ats` | `{ resume, jobDescription, provider?, apiKey? }` | `{ score, breakdown, missingKeywords, recommendations }` |

`userProfile` shape: `{ name, email, phone?, location?, linkedin?, github?, summary?, experience: [{ company, role, startDate, endDate?, description[], technologies? }], education: [{ institution, degree, field, graduationDate, gpa? }], skills: { technical[], soft?, tools? }, projects?, certifications? }`.

### Users & credentials (passwords encrypted with `ENCRYPTION_KEY`, never returned)

| Method | Path | Body |
|---|---|---|
| POST | `/api/users` | `email, name?, profile, preferences { keywords[], locations[], roles[], autoApply, easyApplyOnly, sources[], autoAnswerMode?, notifyEmail?, notifyTopic? }, linkedinEmail?, linkedinPassword?, naukriEmail?, naukriPassword?` |
| GET | `/api/users/:id` | user + last 20 applications (passwords masked) |
| PATCH | `/api/users/:id/credentials` | any of `linkedinEmail, linkedinPassword, naukriEmail, naukriPassword` |
| POST | `/api/users/:id/verify-credentials` | `{ platform: "linkedin"\|"naukri", email?, password? }` — tests login, applies to nothing |
| PATCH | `/api/users/:id/preferences` | partial preferences object (e.g. `{ autoApply: false }` pauses) |

### Screening Q&A (the auto-answer brain)

| Method | Path | Body |
|---|---|---|
| PATCH | `/api/users/:id/qa-profile` | general answers: `workAuth, sponsorship, noticeDays, ctc, expectedCtc, relocation, remote, languages, experienceYears, location, dob, gender` |
| POST | `/api/users/:id/qa` | `{ question, answer }` — exact pair, matched first |
| GET | `/api/users/:id/qa` | `{ qaProfile, answers[] }` |
| POST | `/api/users/:id/answer-preview` | `{ question, fieldType?, options?, jobDescription?, provider?, apiKey? }` → `{ answer, source, confidence?\|error? }` |

Seed the 33 most common LinkedIn/Naukri questions (edit answers first):

```bash
npm run db:seed -- --dry-run            # shows which answers are still empty
npm run db:seed -- --email=you@x.com    # writes qaProfile + answers to Mongo
```

### Jobs (24h watch)

| Method | Path | Body / Query |
|---|---|---|
| POST | `/api/jobs/scrape` | `{ userId, sources? ["linkedin","naukri"], hoursBack? (default 24), maxJobs? (default 50), dryRun? }` |
| GET | `/api/jobs?source=&limit=&q=` | stored jobs, newest first |
| GET | `/api/jobs/matches/:userId` | last-24h jobs not yet applied to |

### Applications & auto-apply

| Method | Path | Body |
|---|---|---|
| POST | `/api/applications/auto-apply` | `{ userId, provider?, apiKey?, maxApplies? (default 5), dryRun? }` → queues BullMQ job |
| GET | `/api/applications/user/:userId` | applications + jobs, newest first (includes `answersUsed`, errors) |
| POST | `/api/applications/:id/retry` | re-queues one `needs_review`/`failed` application |

Statuses: `pending` (dry-run) · `applied` · `failed` · `skipped` (external apply) · `needs_review` (a question needs you — see Inbox).

### Inbox (phone popup queue)

| Method | Path | Body |
|---|---|---|
| GET | `/api/users/:id/inbox` | `{ count, items[] }` — pending questions with job + options; poll every 15–60s |
| POST | `/api/users/:id/inbox/:qid/answer` | `{ answer, provider?, apiKey? }` → learns it; auto-retries the apply when it's the last open question |

## Project layout

```
src/
  index.js                 Express app + rate limit + CORS + helmet
  routes/  health.js        GET /api/health
           resume.js        generate / extract-jd / analyze-ats
           users.js         CRUD + credentials + verify + qa-profile + qa + answer-preview + preferences
           jobs.js          scrape / list / matches
           applications.js  auto-apply enqueue / list
           inbox.js         pending questions + answer + application retry
  services/aiProviders.js  Gemini / OpenAI / Anthropic factory (user key per request, server fallback)
  services/resumeService.js agentic pipeline: analyze JD → tailor → ATS optimize → format + score
  services/jobExtractor.js  JD extraction from any job URL (axios + cheerio)
  services/scraperService.js LinkedIn guest-API + Naukri page scrapers, 24h + keyword filter, Mongo upsert
  services/applicationEngine.js Playwright: LinkedIn login + Easy Apply walker, Naukri login + apply,
                           modal/chat question extraction + auto-fill, resume PDF upload
  services/qaService.js    normalize/match/coerce + stored→qaProfile→LLM + full-auto fallback +
                           pending-question inbox helpers
  services/auth.js         credential resolution (user → env), captcha/2FA/authwall detection
  services/notify.js       free alerts: Gmail SMTP + ntfy.sh push (phone rings with app closed)
  services/pdfGenerator.js ATS-safe single-column PDF (pdfkit)
  lib/       db.js (Mongoose connect) / redis.js / crypto.js
  models/      Mongoose models: User, Job, Application, ScreeningAnswer, PendingQuestion, ScrapingLog
workers/
  processor.js             BullMQ `auto-apply` (scrape→tailor→apply→inbox+notify) + `retry-apply`
  scheduler.js             cron every 2h, enqueues live applies for autoApply users (live by default)
  index.js                 worker entry
data/screening-qa.json     33 seed questions + qaProfile template
scripts/seedQa.js          `npm run db:seed -- --email=… [--dry-run]`
tests/qa.test.js + autoApply.test.js   `npm test` (no DB/browser needed; live-login test is gated)
```

## Behaviour notes (read before going live)

- **Live by default.** Scheduler applies for real (`AUTO_APPLY_LIVE=false` forces dry-run).
- **Full-auto by default.** Every question gets a best-effort answer; set `autoAnswerMode: "assisted"` per user to pause on unsure items instead.
- **Sensitive questions** (disability/veteran/etc.) are only auto-answered in full-auto; in assisted mode they go to the inbox.
- **First LinkedIn login** often hits captcha/2FA — clear it once manually; server logins work after.
- **Rate limits**: scrapers pause ~0.8s between detail fetches; keep `maxJobs ≤ 50`.
- Check the platform ToS for automation on your account; Easy-Apply-only is the default to stay safe.

## Tests

```bash
npm test   # node --test: credential resolution, blocker detection, Q&A incl. full-auto, API validation
```
Live browser login test runs only when `LINKEDIN_*`/`NAUKRI_*` env creds exist **and** `npx playwright install chromium` was run.



<!-- npm start          # API → http://localhost:3000
npm run worker     # apply worker
npm run scheduler  # 30-min watch + 3-min Gmail alert lane -->