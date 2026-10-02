import PDFDocument from 'pdfkit';

// Generates a clean, ATS-safe single-column PDF from tailored resume text.
// Returns a Buffer. Keep layout simple: no tables, no columns, no graphics.
export async function resumeTextToPdf({ name, resumeText }) {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: 'A4', margin: 50 });
      const chunks = [];
      doc.on('data', (c) => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      doc.font('Helvetica-Bold').fontSize(16).text(name || 'Resume', { align: 'center' });
      doc.moveDown(0.5);
      doc.font('Helvetica').fontSize(10);
      const lines = String(resumeText || '').split('\n');
      for (const line of lines) {
        const t = line.trim();
        if (!t) { doc.moveDown(0.4); continue; }
        if (/^[A-Z][A-Z\s&]{3,}$/.test(t) && t.length < 40) {
          doc.moveDown(0.3);
          doc.font('Helvetica-Bold').fontSize(11).text(t);
          doc.font('Helvetica').fontSize(10);
        } else if (t.startsWith('•') || t.startsWith('-')) {
          doc.text(t, { indent: 12 });
        } else {
          doc.text(t);
        }
      }
      doc.end();
    } catch (e) { reject(e); }
  });
}
