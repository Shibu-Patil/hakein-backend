// Primary resume PDF path: structured text -> HTML/CSS -> headless Chromium print.
// Falls back to the pdfkit renderer if Chromium is unavailable.
import { resumeHtmlToPdf } from './resumeHtml.js';
import { resumeTextToPdfFallback } from './pdfFallback.js';

export async function resumeTextToPdf({ name, resumeText }) {
  void name;
  try {
    return await resumeHtmlToPdf(resumeText);
  } catch (e) {
    console.warn('[pdf] chromium render failed, using fallback:', e.message);
    return resumeTextToPdfFallback({ name, resumeText });
  }
}
