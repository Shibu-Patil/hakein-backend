import dotenv from 'dotenv';

dotenv.config();
const { readFile, writeFile } = await import('node:fs/promises');
const pdfParse = (await import('pdf-parse')).default;
const { defaultAI } = await import('../src/lib/agentConfig.js');
const { ResumeService } = await import('../src/services/resumeService.js');
const { resumeTextToPdf } = await import('../src/services/pdfGenerator.js');

const which = process.argv[2] || 'jd2';
const buf = await readFile(`${process.env.HOME}/Downloads/Shubham_Patil_Resume.pdf`);
const resumeText = (await pdfParse(buf)).text.replace(/\s+/g, ' ').trim();
console.log('RESUME CHARS:', resumeText.length, new Date().toISOString());
const jd = await readFile(`/tmp/${which}.txt`, 'utf8');
const ai = defaultAI('resume');
console.log('AGENT:', ai.model);
const svc = new ResumeService();
const out = await svc.tailorFromResumeText(resumeText, jd, ai, { format: 'ats' });
console.log('ATS SCORE:', out.atsScore?.score);
console.log('TOKENS:', JSON.stringify(out.usage?.total));
console.log('MISSING:', JSON.stringify(out.atsScore?.missingKeywords));
await writeFile(`/tmp/tailored-${which}.txt`, out.resume);
const pdf = await resumeTextToPdf({ name: 'Shubham Patil', resumeText: out.resume });
await writeFile(`/Users/shubhampatil/Desktop/pocs/Hekin/Shubham_Patil_Tailored_Resume_Siemens-FullStack-Python.pdf`, pdf);
console.log('PDF bytes:', pdf.length, new Date().toISOString());
