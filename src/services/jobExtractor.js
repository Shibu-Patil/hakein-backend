import axios from 'axios';
import * as cheerio from 'cheerio';

export class JobExtractorService {
  async extractFromUrl(url) {
    try {
      const { data: html } = await axios.get(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        },
        timeout: 10000
      });

      const $ = cheerio.load(html);
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

      return this.cleanJobDescription(text);
    } catch (err) {
      throw new Error(`Failed to extract job description: ${err.message}`);
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