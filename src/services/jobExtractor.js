import axios from 'axios';
import * as cheerio from 'cheerio';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36';

// A real JD mentions at least a couple of these; CSS/JS shells don't.
const JD_SIGNALS = ['responsibilit', 'requirement', 'qualification', 'experience', 'skills', 'apply', 'salary', 'benefits', 'about the role', 'about the job', 'what you'];

export class JobExtractorService {
  looksLikeJD(text) {
    const t = String(text || '');
    if (t.length < 500) return false;
    const low = t.toLowerCase();
    return JD_SIGNALS.filter((s) => low.includes(s)).length >= 2;
  }

  async extractFromUrl(url) {
    try {
      // 1. Fast path: static HTML (LinkedIn guest pages, Greenhouse, Lever, most boards)
      const { data: html } = await axios.get(url, {
        headers: { 'User-Agent': UA },
        timeout: 10000
      });

      const $ = cheerio.load(html);
      $('script, style, noscript, svg, nav, header, footer').remove();
      const selectors = [
        '[data-testid="job-description"]',
        '.job-description',
        '.job-details',
        '.description',
        '#job-description',
        '[class*="job"] [class*="description"]',
        'main',
        'article',
        '.content'
      ];

      let text = '';
      for (const selector of selectors) {
        const element = $(selector).first();
        if (element.length) {
          text = element.text().trim();
          if (text.length > 200) break;
        }
      }

      if (!text || text.length < 200) {
        text = $('body').text().trim();
      }

      text = this.cleanJobDescription(text);
      if (this.looksLikeJD(text)) return text;

      // 2. Slow path: JS-rendered SPA (Rippling, Ashby, some Workday/ADP pages).
      // Render in headless Chromium and read the visible text.
      return await this.extractRendered(url);
    } catch (err) {
      throw new Error(`Failed to extract job description: ${err.message}`);
    }
  }

  async extractRendered(url) {
    let browser = null;
    try {
      const { chromium } = await import('playwright');
      browser = await chromium.launch({ headless: true });
      const page = await (await browser.newContext({ userAgent: UA })).newPage();
      await page.goto(url, { waitUntil: 'networkidle', timeout: 25000 });
      await page.waitForTimeout(2000);
      const text = await page.evaluate(() => {
        document.querySelectorAll('script, style, noscript, nav, header, footer').forEach((el) => el.remove());
        const main = document.querySelector('main, article, [role="main"]');
        return (main ? main.innerText : document.body.innerText) || '';
      });
      const cleaned = this.cleanJobDescription(text);
      if (!this.looksLikeJD(cleaned)) {
        throw new Error('page did not render a readable job description (login wall or bot check?)');
      }
      return cleaned;
    } finally {
      await browser?.close().catch(() => {});
    }
  }

  cleanJobDescription(text) {
    return text
      .replace(/\s+/g, ' ')
      .replace(/[^\x20-\x7E\n]/g, '')
      .trim()
      .substring(0, 15000);
  }

  extractKeyInfo(text) {
    const keywords = [
      'required', 'requirements', 'qualifications', 'skills',
      'experience', 'responsibilities', 'duties', 'must have',
      'nice to have', 'preferred', 'bonus', 'tech stack',
      'technologies', 'tools', 'frameworks', 'languages'
    ];

    const sections = {};
    const lowerText = text.toLowerCase();

    for (const keyword of keywords) {
      const index = lowerText.indexOf(keyword);
      if (index !== -1) {
        const start = Math.max(0, index - 100);
        const end = Math.min(text.length, index + 500);
        sections[keyword] = text.substring(start, end);
      }
    }

    return sections;
  }
}
