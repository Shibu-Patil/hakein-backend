// Generic end-to-end tailor test for ANY resume + JD (no login, no DB).
// Usage:
//   node scripts/testTailorLive.mjs --resume=/path/to/resume.pdf --jd=/path/to/jd.txt [--out=/path/to/out.pdf]
// Resume may be .pdf, .docx, .doc or .txt. JD is a plain-text file.
// Uses agent.yaml active agent (local Ollama or cloud).
import dotenv from 'dotenv';

dotenv.config();

function arg(name, fallback = null) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split('=').slice(1).join('=') : fallback;
}

const resumePath = arg('resume');
const jdPath = arg('jd');
const outPdf = arg('out', '/tmp/tailored-out.pdf');

if (!resumePath || !jdPath) {
  console.error('Usage: node scripts/testTailorLive.mjs --resume=/path/to/resume.pdf --jd=/path/to/jd.txt [--out=/path/to/out.pdf]');
  process.exit(1);
}

const { readFile, writeFile } = await import('node:fs/promises');
const { defaultAI } = await import('../src/lib/agentConfig.js');
const { ResumeService } = await import('../src/services/resumeService.js');
const { resumeTextToPdf } = await import('../src/services/pdfGenerator.js');

async function readResume(path) {
  const buf = await readFile(path);
  const low = path.toLowerCase();
  if (low.endsWith('.pdf')) {
    const pdfParse = (await import('pdf-parse')).default;
    return (await pdfParse(buf)).text;
  }
  if (low.endsWith('.docx') || low.endsWith('.doc')) {
    const mammoth = await import('mammoth');
    return (await mammoth.extractRawText({ buffer: buf })).value;
  }
  return buf.toString('utf8');
}

const resumeText = (await readResume(resumePath)).replace(/\s+/g, ' ').trim();
console.log('RESUME CHARS:', resumeText.length, new Date().toISOString());
const jd = await readFile(jdPath, 'utf8');
const ai = defaultAI('resume');
console.log('AGENT:', ai.model);
const svc = new ResumeService();
const out = await svc.tailorFromResumeText(resumeText, jd, ai, { format: 'ats' });
console.log('ATS SCORE:', out.atsScore?.score);
console.log('TOKENS:', JSON.stringify(out.usage?.total));
console.log('STEPS:', JSON.stringify(out.usage?.steps?.map((s) => `${s.step}:${s.total || 0}`)));
console.log('MISSING:', JSON.stringify(out.atsScore?.missingKeywords));
console.log('HONESTY:', JSON.stringify(out.honesty));
const pdf = await resumeTextToPdf({ name: 'Resume', resumeText: out.resume });
await writeFile(outPdf, pdf);
console.log('PDF bytes:', pdf.length, '->', outPdf, new Date().toISOString());
