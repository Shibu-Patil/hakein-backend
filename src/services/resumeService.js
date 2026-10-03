import { v4 as uuidv4 } from 'uuid';

// Pure: sum per-step usage into totals.
export function sumUsage(steps = []) {
  const total = { input: 0, output: 0, total: 0 };
  for (const s of steps) {
    total.input += s.input || 0;
    total.output += s.output || 0;
    total.total += s.total || 0;
  }
  return total;
}

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();

// Split "SSO (Single Sign-On)" into alternatives: ["sso", "single sign on"].
function alternatives(keyword) {
  const parts = String(keyword).split(/[()/|]/).map(norm).filter(Boolean);
  return parts.length ? parts : [norm(keyword)];
}

// Known equivalences: OAuth2/JWT proves SSO, monitoring proves observability, etc.
const EQUIV = {
  sso: ['sso', 'single sign on', 'oauth2', 'jwt', 'saml', 'sso single sign on'],
  observability: ['observability', 'monitoring', 'logging', 'tracing', 'prometheus', 'grafana', 'elk'],
  kubernetes: ['kubernetes', 'k8s'],
  docker: ['docker', 'container', 'containerization'],
  cicd: ['ci cd', 'cicd', 'ci/cd', 'pipeline'],
  aws: ['aws', 'amazon web services', 'ec2', 's3', 'lambda'],
  graphql: ['graphql', 'graph ql'],
  typescript: ['typescript', 'ts'],
  javascript: ['javascript', 'js', 'es6'],
  nodejs: ['node js', 'nodejs', 'node'],
  react: ['react', 'react js', 'reactjs', 'next js', 'nextjs'],
};

// Pure: which keywords are truly absent? Exact phrase, all-words, or known equivalent.
export function findMissingKeywords(resumeText, keywords = []) {
  const hay = ` ${norm(resumeText)} `;
  const has = (term) => {
    const t = norm(term);
    if (!t) return false;
    if (t.includes(' ')) return hay.includes(` ${t} `);
    return hay.includes(` ${t} `) || hay.includes(` ${t}-`) || hay.includes(`-${t} `);
  };
  const missing = [];
  for (const kw of keywords) {
    const cands = new Set();
    for (const a of alternatives(kw)) {
      cands.add(a);
      for (const w of a.split(' ')) {
        if (EQUIV[w]) for (const e of EQUIV[w]) cands.add(e);
      }
      if (EQUIV[a]) for (const e of EQUIV[a]) cands.add(e);
    }
    const found = [...cands].some((c) => {
      if (has(c)) return true;
      const words = c.split(' ').filter((w) => w.length > 2);
      return words.length > 0 && words.every(has);
    });
    if (!found) missing.push(kw);
  }
  return missing;
}

export class ResumeService {
  // Wrap one model call and record its token usage under `step`.
  async callWithUsage(aiProvider, step, bucket, fn) {
    const text = await fn();
    const u = aiProvider.lastUsage;
    bucket.push({ step, model: aiProvider.model, ...(u || { input: 0, output: 0, total: 0, estimated: true }) });
    return text;
  }
  // Public flow: raw resume text -> structured profile -> normal tailored pipeline.
  // No login, no saved profile needed.
  async tailorFromResumeText(resumeText, jobDescription, aiProvider, options = {}) {
    const preSteps = [];
    const userProfile = await this.callWithUsage(aiProvider, 'parse-resume', preSteps, () => this.parseResumeText(resumeText, aiProvider));
    const result = await this.generateTailoredResume(userProfile, jobDescription, aiProvider, options);
    const steps = [...preSteps, ...result.usage.steps];
    result.usage = { steps, total: sumUsage(steps) };
    return result;
  }

  async parseResumeText(resumeText, aiProvider) {
    const prompt = `Extract this resume into structured JSON. Keep every employer, role, date, bullet, skill, school, and project. Do not invent anything missing.

RESUME:
${String(resumeText).slice(0, 12000)}

Return ONLY JSON:
{"name":"","email":"","phone":"","location":"","linkedin":"","github":"","summary":"","experience":[{"company":"","role":"","startDate":"","endDate":"","description":[""],"technologies":[""]}],"education":[{"institution":"","degree":"","field":"","graduationDate":""}],"skills":{"technical":[""],"soft":[],"tools":[]},"projects":[],"certifications":[]}`;
    const response = await aiProvider.generate(prompt);
    return this.parseJSON(response);
  }

  async generateTailoredResume(userProfile, jobDescription, aiProvider, options = {}) {
    const usage = [];
    const call = (step, fn) => this.callWithUsage(aiProvider, step, usage, fn);
    const analysis = await call('analyze-jd', () => this.analyzeJobDescription(jobDescription, aiProvider));
    const tailoredContent = await call('tailor', () => this.generateTailoredContent(
      userProfile,
      jobDescription,
      analysis,
      aiProvider,
      options
    ));
    const atsOptimized = await call('ats-optimize', () => this.optimizeForATS(tailoredContent, jobDescription, aiProvider));
    let formatted = this.formatResume(atsOptimized, userProfile, options.format || 'ats');
    let atsScore = await call('ats-score', () => this.calculateATSScore(formatted, jobDescription, aiProvider));

    // Repair loop: weave still-missing must-have keywords back in (max 2 rounds).
    const mustHave = [...new Set([...(analysis.mustHaveKeywords || []), ...(analysis.keywords || [])])];
    for (let round = 0; round < 2; round++) {
      const missing = findMissingKeywords(formatted, mustHave).slice(0, 6);
      if (!missing.length) break;
      formatted = await call(`repair-${round + 1}`, () => this.repairKeywords(formatted, missing, aiProvider));
      atsScore = await call(`ats-score-${round + 1}`, () => this.calculateATSScore(formatted, jobDescription, aiProvider));
    }

    return {
      id: uuidv4(),
      resume: formatted,
      analysis,
      atsScore,
      usage: { steps: usage, total: sumUsage(usage) },
      metadata: {
        generatedAt: new Date().toISOString(),
        provider: aiProvider.constructor.name,
        model: aiProvider.model,
        jobDescriptionLength: jobDescription.length,
        targetRole: options.targetRole
      }
    };
  }

  async analyzeJobDescription(jobDescription, aiProvider) {
    const prompt = `Analyze this job description and extract key information for resume tailoring:

JOB DESCRIPTION:
${jobDescription}

Return JSON with:
{
  "requiredSkills": ["skill1", "skill2"],
  "preferredSkills": ["skill1"],
  "keyResponsibilities": ["resp1", "resp2"],
  "keywords": ["keyword1", "keyword2"],
  "experienceLevel": "junior|mid|senior|lead",
  "roleType": "frontend|backend|fullstack|devops|data|mobile|other",
  "industry": "industry name",
  "companyCulture": ["value1", "value2"],
  "mustHaveKeywords": ["keyword1"],
  "niceToHaveKeywords": ["keyword1"]
}`;

    const response = await aiProvider.generate(prompt);
    return this.parseJSON(response);
  }

  async generateTailoredContent(userProfile, jobDescription, analysis, aiProvider, options) {
    const prompt = `You are an expert resume writer and ATS optimization specialist. Create a tailored resume that achieves 100% ATS compatibility.

USER PROFILE:
${JSON.stringify(userProfile, null, 2)}

JOB ANALYSIS:
${JSON.stringify(analysis, null, 2)}

JOB DESCRIPTION:
${jobDescription}

OPTIONS:
- Target Role: ${options.targetRole || 'Auto-detect'}
- Emphasis: ${options.emphasis?.join(', ') || 'Auto'}
- Exclude Keywords: ${options.excludeKeywords?.join(', ') || 'None'}
- Format: ${options.format || 'ats'}

INSTRUCTIONS:
1. Rewrite professional summary to match job requirements exactly
2. Reorder and rewrite experience bullets to highlight relevant achievements
3. Quantify achievements with metrics (%, $, time saved, scale)
4. Include ALL required skills and keywords naturally — every keyword from JOB ANALYSIS must appear at least once
5. Match job description language and terminology
6. Prioritize most relevant experience first
7. Remove or de-emphasize irrelevant experience
8. Ensure 100% ATS parseability - standard sections, no tables/graphics
9. Use action verbs and STAR method (Situation, Task, Action, Result)
10. Target role: ${options.targetRole || 'Match job title'}

HONESTY RULES (strict, never break):
- Years of experience may be rounded UP by at most +1 year (3 becomes max 4, 5 becomes max 6). Never more.
- Never invent employers, degrees, or certifications the profile does not have.
- Skills MAY be added or expanded to match the JD keywords (e.g. list a tool the candidate can reasonably use).
- Every keyword must appear at least once, worked naturally into summary, bullets, or skills.

Return JSON with tailored resume sections:
{
  "summary": "tailored professional summary",
  "experience": [
    {
      "company": "...",
      "role": "...",
      "startDate": "...",
      "endDate": "...",
      "description": ["bullet1", "bullet2"],
      "technologies": ["tech1", "tech2"],
      "achievements": ["quantified achievement"]
    }
  ],
  "skills": {
    "technical": ["skill1", "skill2"],
    "soft": ["skill1"],
    "tools": ["tool1"]
  },
  "projects": [
    {
      "name": "...",
      "description": "...",
      "technologies": ["tech1"],
      "relevance": "why relevant to this job"
    }
  ],
  "keywordsUsed": ["keyword1", "keyword2"]
}`;

    const response = await aiProvider.generate(prompt);
    return this.parseJSON(response);
  }

  async repairKeywords(resumeText, missing, aiProvider) {
    const prompt = `This resume is missing these required keywords: ${missing.join(', ')}.

RESUME:
${String(resumeText).slice(0, 12000)}

RULES:
- Weave EACH missing keyword into the resume naturally (summary, an existing bullet, or skills). Skills may be added.
- Change nothing else. Keep every section, date, and bullet intact.
- Experience years stay as-is (max +1 rounding already applied).
Return the FULL updated resume text, nothing else.`;
    return aiProvider.generate(prompt);
  }

  async optimizeForATS(content, jobDescription, aiProvider) {
    const prompt = `Optimize this resume content for 100% ATS compatibility:

CURRENT CONTENT:
${JSON.stringify(content, null, 2)}

JOB DESCRIPTION:
${jobDescription}

ATS OPTIMIZATION RULES:
1. Use standard section headers (Summary, Experience, Education, Skills, Projects, Certifications)
2. No tables, columns, graphics, headers/footers, text boxes
3. Standard fonts only (Arial, Calibri, Times New Roman)
4. Keywords from JD must appear naturally in context
5. Dates in MM/YYYY format
6. No special characters or unicode
7. Simple bullet points (• or -)
8. Contact info at top in plain text
9. Section order: Summary, Experience, Skills, Education, Projects, Certifications
10. Each bullet: Action verb + Task + Result + Metric

Return optimized JSON with same structure.`;

    const response = await aiProvider.generate(prompt);
    return this.parseJSON(response);
  }

  async calculateATSScore(resume, jobDescription, aiProvider) {
    const prompt = `Score this resume for ATS compatibility against the job description (0-100):

RESUME:
${JSON.stringify(resume, null, 2)}

JOB DESCRIPTION:
${jobDescription}

Evaluate:
1. Keyword match (required skills, tools, technologies)
2. Section completeness and standard formatting
3. Quantified achievements
4. Relevance of experience
5. Keyword density and natural placement
6. Parseability (no tables, graphics, special formatting)

Return JSON: { "score": 95, "breakdown": { "keywords": 90, "format": 100, "relevance": 95, "quantification": 90 }, "missingKeywords": ["kw1"], "recommendations": ["rec1"] }`;

    const response = await aiProvider.generate(prompt);
    return this.parseJSON(response);
  }

  async analyzeATS(resume, jobDescription, aiProvider) {
    return this.calculateATSScore(resume, jobDescription, aiProvider);
  }

  formatResume(content, userProfile, format) {
    const sections = [];

    sections.push(this.formatHeader(userProfile));
    sections.push(this.formatSummary(content.summary));
    sections.push(this.formatExperience(content.experience));
    sections.push(this.formatSkills(content.skills));
    sections.push(this.formatEducation(userProfile.education));
    
    if (content.projects?.length) {
      sections.push(this.formatProjects(content.projects));
    }
    
    if (userProfile.certifications?.length) {
      sections.push(this.formatCertifications(userProfile.certifications));
    }

    return sections.join('\n\n');
  }

  formatHeader(profile) {
    const lines = [
      profile.name.toUpperCase(),
      `${profile.email} | ${profile.phone || ''} | ${profile.location || ''}`,
      `${profile.linkedin || ''} ${profile.github ? '| ' + profile.github : ''}`.trim()
    ].filter(Boolean);
    return lines.join('\n');
  }

  formatSummary(summary) {
    return `PROFESSIONAL SUMMARY\n${summary}`;
  }

  formatExperience(experience) {
    const lines = ['EXPERIENCE'];
    for (const exp of experience) {
      lines.push(`${exp.role} | ${exp.company} | ${exp.startDate} - ${exp.endDate || 'Present'}`);
      for (const bullet of exp.description) {
        lines.push(`• ${bullet}`);
      }
      if (exp.technologies?.length) {
        lines.push(`Technologies: ${exp.technologies.join(', ')}`);
      }
    }
    return lines.join('\n');
  }

  formatSkills(skills) {
    const lines = ['SKILLS'];
    if (skills.technical?.length) lines.push(`Technical: ${skills.technical.join(', ')}`);
    if (skills.tools?.length) lines.push(`Tools: ${skills.tools.join(', ')}`);
    if (skills.soft?.length) lines.push(`Soft Skills: ${skills.soft.join(', ')}`);
    return lines.join('\n');
  }

  formatEducation(education) {
    const lines = ['EDUCATION'];
    for (const edu of education) {
      lines.push(`${edu.degree} in ${edu.field} | ${edu.institution} | ${edu.graduationDate}${edu.gpa ? ` | GPA: ${edu.gpa}` : ''}`);
    }
    return lines.join('\n');
  }

  formatProjects(projects) {
    const lines = ['PROJECTS'];
    for (const proj of projects) {
      lines.push(`${proj.name} | ${proj.technologies.join(', ')}`);
      lines.push(`• ${proj.description}`);
      if (proj.link) lines.push(`Link: ${proj.link}`);
    }
    return lines.join('\n');
  }

  formatCertifications(certifications) {
    const lines = ['CERTIFICATIONS'];
    for (const cert of certifications) {
      lines.push(`${cert.name} | ${cert.issuer} | ${cert.date}`);
    }
    return lines.join('\n');
  }

  parseJSON(text) {
    try {
      const match = text.match(/\{[\s\S]*\}/);
      if (match) {
        return JSON.parse(match[0]);
      }
      return JSON.parse(text);
    } catch (err) {
      console.error('JSON parse error:', err.message);
      console.error('Raw text:', text.substring(0, 500));
      throw new Error('Failed to parse AI response');
    }
  }
}