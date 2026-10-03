import PDFDocument from 'pdfkit';

// Visually polished, single-column resume PDF from tailored resume text.
// Still ATS-safe: selectable text only, no tables/columns/images.
// Pagination: fits on 1 page when possible; if only ~3 lines spill over,
// spacing + type shrink slightly to keep it on one page; longer content flows to 2 pages.

const ACCENT = '#1e3a5f';
const MUTED = '#5b6470';

function parseBlocks(resumeText) {
  const blocks = [];
  for (const raw of String(resumeText || '').split('\n')) {
    const t = raw.trim();
    if (!t) {
      blocks.push({ kind: 'gap' });
      continue;
    }
    if (/^[A-Z][A-Z\s&/]{3,}$/.test(t) && t.length < 45) {
      blocks.push({ kind: 'section', text: t });
    } else if (/^[•\-*]\s?/.test(t)) {
      blocks.push({ kind: 'bullet', text: t.replace(/^[•\-*]\s?/, '') });
    } else if (/\|/.test(t) && t.length < 140) {
      blocks.push({ kind: 'jobline', text: t });
    } else {
      blocks.push({ kind: 'para', text: t });
    }
  }
  return blocks;
}

function measure(blocks, opt) {
  // Analytical height estimate using pdfkit's own metrics on a throwaway doc.
  const probe = new PDFDocument({ size: 'A4', margin: opt.margin });
  const W = probe.page.width - opt.margin * 2;
  let h = 0;
  const line = (size) => size * 1.32;
  h += 26 + 6; // name
  h += line(9) + 4; // contact
  h += 8; // rule gap
  for (const b of blocks) {
    if (b.kind === 'gap') { h += opt.gap; continue; }
    if (b.kind === 'section') { h += 8 + line(11) + 5; continue; }
    if (b.kind === 'bullet') {
      h += probe.heightOfString(b.text, { width: W - 18, font: 'Helvetica', size: opt.body }) + 2;
      continue;
    }
    if (b.kind === 'jobline') { h += line(opt.body) + 3 + 2; continue; }
    h += probe.heightOfString(b.text, { width: W, font: 'Helvetica', size: opt.body }) + 2;
  }
  return { height: h, page: probe.page.height - opt.margin * 2 };
}

function render(blocks, opt) {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: 'A4', margin: opt.margin, bufferPages: true });
      const chunks = [];
      doc.on('data', (c) => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      const W = doc.page.width - opt.margin * 2;
      let firstPage = true;

      const header = (name, contact) => {
        doc.font('Helvetica-Bold').fontSize(19).fillColor('#111827')
          .text(name || 'Resume', { align: 'center' });
        if (contact) {
          doc.moveDown(0.25);
          doc.font('Helvetica').fontSize(9).fillColor(MUTED).text(contact, { align: 'center' });
        }
        doc.moveDown(0.4);
        doc.strokeColor(ACCENT).lineWidth(1.5)
          .moveTo(opt.margin, doc.y).lineTo(opt.margin + W, doc.y).stroke();
        doc.moveDown(0.5);
        doc.fillColor('#111827');
        firstPage = false;
      };

      const section = (text) => {
        doc.moveDown(0.35);
        doc.font('Helvetica-Bold').fontSize(11).fillColor(ACCENT)
          .text(text.toUpperCase(), { characterSpacing: 0.8 });
        doc.moveDown(0.15);
        doc.strokeColor('#cbd5e1').lineWidth(0.75)
          .moveTo(opt.margin, doc.y).lineTo(opt.margin + W, doc.y).stroke();
        doc.moveDown(0.3);
        doc.fillColor('#111827');
      };

      const bullet = (text) => {
        const x = doc.x;
        doc.font('Helvetica').fontSize(opt.body).fillColor('#1f2937');
        doc.text('•', x + 2, doc.y, { continued: false });
        const y = doc.y - opt.body * 1.32;
        doc.text(text, x + 16, y, { width: W - 16 });
        doc.moveDown(0.18);
      };

      const jobline = (text) => {
        const [left, ...rest] = text.split('|').map((s) => s.trim());
        doc.font('Helvetica-Bold').fontSize(opt.body).fillColor('#111827').text(left);
        if (rest.length) {
          doc.font('Helvetica').fontSize(opt.body - 0.5).fillColor(MUTED).text(rest.join(' | '));
        }
        doc.moveDown(0.15);
      };

      const para = (text) => {
        doc.font('Helvetica').fontSize(opt.body).fillColor('#1f2937').text(text, { align: 'justify' });
        doc.moveDown(0.18);
      };

      // Name = first line, period. Contact = following non-section lines (joined).
      const nonEmpty = blocks.filter((b) => b.kind !== 'gap');
      const name = (nonEmpty[0]?.text || 'Resume').replace(/^[•\-*]\s?/, '');
      const contactLines = [];
      let restIdx = 1;
      for (let i = 1; i < nonEmpty.length && contactLines.length < 3; i++) {
        if (nonEmpty[i].kind === 'section') break;
        contactLines.push(nonEmpty[i].text);
        restIdx = i + 1;
      }
      const contact = contactLines.join('  |  ');
      const rest = nonEmpty.slice(restIdx);
      header(name, contact);
      for (const b of rest) {
        if (b.kind === 'section') section(b.text);
        else if (b.kind === 'bullet') bullet(b.text);
        else if (b.kind === 'jobline') jobline(b.text);
        else para(b.text);
      }

      // Subtle page numbers only when it actually runs to 2 pages.
      const range = doc.bufferedPageRange();
      if (range.count > 1) {
        for (let i = 0; i < range.count; i++) {
          doc.switchToPage(i);
          doc.font('Helvetica').fontSize(8).fillColor('#9ca3af')
            .text(`Page ${i + 1} of ${range.count}`, opt.margin, doc.page.height - 32, { align: 'center', width: W });
        }
      }
      doc.end();
      void firstPage;
    } catch (e) { reject(e); }
  });
}

export async function resumeTextToPdf({ name, resumeText }) {
  const blocks = parseBlocks(resumeText);
  const normal = { body: 10, gap: 4, margin: 50 };
  const compact = { body: 9.5, gap: 2.5, margin: 46 };

  const { height, page } = measure(blocks, normal);
  if (height <= page) return render(blocks, normal);

  // Only ~3 lines spill? Shrink slightly to hold one page.
  const spill = height - page;
  const lineH = normal.body * 1.32;
  if (spill <= lineH * 3.5) {
    const c = measure(blocks, compact);
    if (c.height <= c.page) return render(blocks, compact);
  }
  // Genuinely long: clean two pages.
  void name;
  return render(blocks, normal);
}
