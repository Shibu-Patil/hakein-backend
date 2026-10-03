// Structured resume -> polished HTML -> print-to-PDF via headless Chromium.
// Real CSS layout: no orphan lines, no manual line math, correct unicode.

export function esc(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export function parseResume(resumeText) {
  const lines = String(resumeText || '').split('\n').map((l) => l.trim());
  const nonEmpty = lines.filter(Boolean);
  const name = (nonEmpty[0] || 'Resume').replace(/^[•\-*]\s?/, '');

  const contact = [];
  const sections = [];
  let current = null;
  let started = false;

  const isSection = (t) => /^[A-Z][A-Z\s&/]{3,}$/.test(t) && t.length < 45;
  const isBullet = (t) => /^[•\-*]\s?/.test(t);
  const stripBullet = (t) => t.replace(/^[•\-*]\s?/, '');

  for (let i = 1; i < nonEmpty.length; i++) {
    const t = nonEmpty[i];
    if (!started && !isSection(t)) {
      if (contact.length < 3) { contact.push(t); continue; }
    }
    started = true;
    if (isSection(t)) {
      current = { heading: t, items: [] };
      sections.push(current);
      continue;
    }
    if (!current) {
      current = { heading: '', items: [] };
      sections.push(current);
    }
    if (isBullet(t)) {
      const last = current.items[current.items.length - 1];
      if (last && last.type === 'bullets') last.lines.push(stripBullet(t));
      else current.items.push({ type: 'bullets', lines: [stripBullet(t)] });
    } else if (/\|/.test(t) && t.length < 160) {
      const [title, ...rest] = t.split('|').map((s) => s.trim());
      current.items.push({ type: 'job', title, sub: rest.join(' | ') });
    } else if (/^(technologies|tools|tech stack)\s*:/i.test(t)) {
      current.items.push({ type: 'tech', text: t });
    } else {
      const last = current.items[current.items.length - 1];
      if (last && last.type === 'para') last.text += ' ' + t;
      else current.items.push({ type: 'para', text: t });
    }
  }

  return { name, contact: contact.join('  |  '), sections };
}

export function renderHtml(doc) {
  const itemHtml = (item) => {
    if (item.type === 'job') {
      return `<div class="job"><div class="job-title">${esc(item.title)}</div>${
        item.sub ? `<div class="job-sub">${esc(item.sub)}</div>` : ''
      }</div>`;
    }
    if (item.type === 'bullets') {
      return `<ul>${item.lines.map((l) => `<li>${esc(l)}</li>`).join('')}</ul>`;
    }
    if (item.type === 'tech') {
      return `<div class="tech">${esc(item.text)}</div>`;
    }
    return `<p>${esc(item.text)}</p>`;
  };

  const sections = doc.sections
    .map(
      (s) => `<section>${s.heading ? `<h2>${esc(s.heading)}</h2>` : ''}${s.items.map(itemHtml).join('')}</section>`
    )
    .join('');

  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
    @page { size: A4; margin: 16mm 15mm 14mm 15mm; }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: Arial, Helvetica, sans-serif; color: #1a1a1a; font-size: 10pt; line-height: 1.42; }
    header { text-align: center; margin-bottom: 10pt; }
    header h1 { font-size: 20pt; letter-spacing: 1.5pt; text-transform: uppercase; color: #111; margin-bottom: 3pt; }
    header .contact { font-size: 8.5pt; color: #555; }
    header .rule { height: 2pt; background: #1e3a5f; margin-top: 7pt; }
    section { margin-bottom: 8pt; }
    h2 { font-size: 10.5pt; letter-spacing: 1.2pt; text-transform: uppercase; color: #1e3a5f;
         border-bottom: 1pt solid #cbd5e1; padding-bottom: 2pt; margin-bottom: 5pt; }
    .job { margin: 5pt 0 2pt 0; break-inside: avoid; }
    .job-title { font-weight: bold; font-size: 10pt; }
    .job-sub { font-size: 9pt; color: #555; margin-top: 1pt; }
    ul { margin: 2pt 0 4pt 14pt; }
    li { margin-bottom: 2pt; text-align: left; }
    li::marker { color: #1e3a5f; }
    p { margin: 2pt 0 4pt 0; text-align: justify; widows: 3; orphans: 3; }
    .tech { font-size: 9pt; color: #333; margin: 1pt 0 5pt 0; }
    .footer { text-align: center; font-size: 8pt; color: #999; }
  </style></head><body>
  <header><h1>${esc(doc.name)}</h1>${doc.contact ? `<div class="contact">${esc(doc.contact)}</div>` : ''}<div class="rule"></div></header>
  ${sections}
  </body></html>`;
}

export async function htmlToPdfBuffer(html) {
  let browser = null;
  try {
    const { chromium } = await import('playwright');
    browser = await chromium.launch({ headless: true });
    const page = await (await browser.newContext()).newPage();
    await page.setContent(html, { waitUntil: 'networkidle', timeout: 20000 });
    return await page.pdf({ format: 'A4', printBackground: true, margin: { top: '16mm', bottom: '14mm', left: '15mm', right: '15mm' } });
  } finally {
    await browser?.close().catch(() => {});
  }
}

export async function resumeHtmlToPdf(resumeText) {
  const doc = parseResume(resumeText);
  return htmlToPdfBuffer(renderHtml(doc));
}
