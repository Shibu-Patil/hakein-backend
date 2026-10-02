import dotenv from 'dotenv';

dotenv.config();
const { readFile, writeFile } = await import('node:fs/promises');
const pdfParse = (await import('pdf-parse')).default;
const { defaultAI } = await import('../src/lib/agentConfig.js');
const { ResumeService } = await import('../src/services/resumeService.js');

const buf = await readFile(`${process.env.HOME}/Downloads/Shubham_Patil_Resume.pdf`);
const resumeText = (await pdfParse(buf)).text.replace(/\s+/g, ' ').trim();
console.log('RESUME CHARS:', resumeText.length, new Date().toISOString());
const jd = await readFile('/tmp/jd.txt', 'utf8');
const ai = defaultAI('resume');
console.log('AGENT:', ai.model);
const svc = new ResumeService();
const out = await svc.tailorFromResumeText(resumeText, jd, ai, { format: 'ats' });
console.log('ATS SCORE:', out.atsScore?.score);
console.log('TOKENS:', JSON.stringify(out.usage?.total));
console.log('STEPS:', JSON.stringify(out.usage?.steps?.map((s) => `${s.step}:${s.total || 0}`)));
console.log('MISSING:', JSON.stringify(out.atsScore?.missingKeywords));
console.log('RECS:', JSON.stringify(out.atsScore?.recommendations)?.slice(0, 400));
await writeFile('/tmp/tailored.txt', out.resume);
console.log('TAILORED CHARS:', out.resume.length, 'saved /tmp/tailored.txt', new Date().toISOString());
