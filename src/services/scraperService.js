import axios from 'axios';
import * as cheerio from 'cheerio';
import { prisma } from '../lib/prisma.js';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36';

function hoursAgo(h) { return new Date(Date.now() - h * 60 * 60 * 1000); }

function matchesPrefs(job, prefs) {
  const hay = `${job.title} ${job.company} ${job.location} ${job.description}`.toLowerCase();
  const kws = (prefs?.keywords || []).map((k) => String(k).toLowerCase());
  if (!kws.length) return true;
  return kws.some((k) => hay.includes(k));
}

// LinkedIn public guest API (no login): works for search + detail pages.
// Note: aggressive scraping gets rate-limited. Keep maxJobs small, add delays.
async function scrapeLinkedIn({ keywords, locations, hoursBack, maxJobs }) {
  const jobs = [];
  const kw = encodeURIComponent((keywords || ['software engineer']).join(' '));
  const loc = encodeURIComponent((locations && locations[0]) || 'India');
  const url = `https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search?keywords=${kw}&location=${loc}&f_TPR=r${Math.min(Math.max(hoursBack, 1), 24 * 7)}&start=0`;

  const { data: html } = await axios.get(url, { headers: { 'User-Agent': UA }, timeout: 15000 });
  const $ = cheerio.load(html);
  const cards = $('li').slice(0, maxJobs);

  for (const el of cards.toArray()) {
    try {
      const $el = $(el);
      const title = $el.find('h3').first().text().trim();
      const company = $el.find('h4').first().text().trim();
      const location = $el.find('[class*="location"]').first().text().trim() || locations?.[0] || 'India';
      const detailUrl = $el.find('a').first().attr('href')?.split('?')[0];
      if (!title || !detailUrl) continue;
      const idMatch = detailUrl.match(/(\d{6,})/);
      const externalId = idMatch ? idMatch[1] : detailUrl;
      // Fetch JD detail (guest page)
      let description = '';
      try {
        const d = await axios.get(detailUrl, { headers: { 'User-Agent': UA }, timeout: 15000 });
        const $$ = cheerio.load(d.data);
        description = $$('.description__text, .show-more-less-html__markup').first().text().trim().replace(/\s+/g, ' ').slice(0, 15000);
      } catch { description = `${title} at ${company}`; }
      jobs.push({
        source: 'linkedin',
        externalId,
        title, company, location,
        url: detailUrl,
        description: description || `${title} at ${company}`,
        postedAt: new Date(),
        rawData: { via: 'guest-api' }
      });
      await new Promise((r) => setTimeout(r, 800));
    } catch { /* skip bad card */ }
  }
  return jobs;
}

// Naukri: uses public search page parsing (no login). Login only needed for apply step.
async function scrapeNaukri({ keywords, locations, hoursBack, maxJobs }) {
  const jobs = [];
  const kw = encodeURIComponent((keywords || ['software engineer']).join(' '));
  const url = `https://www.naukri.com/${kw.replace(/%20/g, '-')}-jobs?k=${kw}&experience=0`;
  try {
    const { data: html } = await axios.get(url, { headers: { 'User-Agent': UA }, timeout: 15000 });
    const $ = cheerio.load(html);
    // Naukri embeds JSON in __NEXT_DATA__
    const nextData = $('#__NEXT_DATA__').html();
    if (nextData) {
      const parsed = JSON.parse(nextData);
      const list = parsed?.props?.pageProps?.jobDetails || parsed?.props?.pageProps?.jobs || [];
      for (const j of list.slice(0, maxJobs)) {
        jobs.push({
          source: 'naukri',
          externalId: String(j.jobId || j.id || j.url || Math.random()),
          title: j.title || j.jobTitle || 'Unknown',
          company: j.companyName || j.company || 'Unknown',
          location: j.location || j.locations?.join(', ') || locations?.[0] || 'India',
          url: j.url || j.jobUrl || url,
          description: (j.description || j.jobDescription || '').toString().slice(0, 15000) || `${j.title}`,
          postedAt: new Date(),
          rawData: { via: 'next-data' }
        });
      }
    }
    // Fallback: parse srp job cards from HTML
    if (!jobs.length) {
      $('article.jobTuple, div.srp-jobtuple-wrapper').slice(0, maxJobs).each((_, el) => {
        const $el = $(el);
        const title = $el.find('a.title').first().text().trim();
        if (!title) return;
        jobs.push({
          source: 'naukri',
          externalId: $el.find('a.title').attr('href') || `${title}-${Date.now()}`,
          title,
          company: $el.find('a.subTitle').first().text().trim() || 'Unknown',
          location: $el.find('[class*="loc"]').first().text().trim() || 'India',
          url: $el.find('a.title').attr('href') || url,
          description: $el.text().trim().replace(/\s+/g, ' ').slice(0, 8000),
          postedAt: new Date(),
          rawData: { via: 'html-fallback' }
        });
      });
    }
  } catch (e) {
    console.warn('[naukri] scrape failed:', e.message);
  }
  return jobs;
}

export async function scrapeJobs(user, { sources = ['linkedin', 'naukri'], hoursBack = 24, maxJobs = 50, dryRun = false } = {}) {
  const started = Date.now();
  const prefs = user.preferences || {};
  const keywords = prefs.keywords?.length ? prefs.keywords : ['software engineer'];
  const locations = prefs.locations?.length ? prefs.locations : ['India'];
  const perSource = Math.ceil(maxJobs / sources.length);

  let all = [];
  const logs = [];
  for (const src of sources) {
    try {
      const found = src === 'linkedin'
        ? await scrapeLinkedIn({ keywords, locations, hoursBack, maxJobs: perSource })
        : await scrapeNaukri({ keywords, locations, hoursBack, maxJobs: perSource });
      const cutoff = hoursAgo(hoursBack);
      const fresh = found.filter((j) => matchesPrefs(j, prefs));
      logs.push({ source: src, found: found.length, kept: fresh.length });
      all.push(...fresh);
    } catch (e) {
      logs.push({ source: src, error: e.message });
      try {
        await prisma.scrapingLog.create({ data: { source: src, status: 'failed', jobsFound: 0, jobsNew: 0, error: e.message.slice(0, 500), duration: Date.now() - started } });
      } catch { /* db may be down */ }
    }
  }

  if (dryRun) return { dryRun: true, logs, jobs: all.slice(0, maxJobs) };

  let inserted = 0;
  const jobsToReturn = [];
  for (const j of all.slice(0, maxJobs)) {
    try {
      const rec = await prisma.job.upsert({
        where: { source_externalId: { source: j.source, externalId: String(j.externalId).slice(0, 200) } },
        update: {},
        create: {
          source: j.source,
          externalId: String(j.externalId).slice(0, 200),
          title: j.title.slice(0, 300),
          company: j.company.slice(0, 200),
          location: j.location.slice(0, 200),
          url: j.url.slice(0, 1000),
          description: j.description.slice(0, 15000),
          postedAt: j.postedAt,
          rawData: j.rawData || {}
        }
      });
      inserted++;
      jobsToReturn.push(rec);
    } catch { /* duplicate */ }
  }
  try {
    for (const l of logs) {
      if (!l.error) await prisma.scrapingLog.create({ data: { source: l.source, status: 'success', jobsFound: l.found, jobsNew: inserted, duration: Date.now() - started } });
    }
  } catch { /* ignore */ }
  return { inserted, logs, jobs: jobsToReturn };
}
